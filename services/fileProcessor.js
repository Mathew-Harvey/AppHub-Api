const AdmZip = require('adm-zip');
const path = require('path');

const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '__pycache__'];
const SKIP_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'];
const TEXT_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  '.json', '.md', '.txt', '.yaml', '.yml', '.toml', '.xml', '.svg',
  '.env', '.gitignore', '.prettierrc', '.eslintrc', '.babelrc',
  '.sh', '.bat', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.lua', '.sql',
  '.graphql', '.gql', '.proto', '.conf', '.ini', '.cfg',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp']);
const MAX_BASE64_IMAGE_SIZE = 50 * 1024; // 50KB
const MAX_MANIFEST_TOKENS = 800_000;
const CHARS_PER_TOKEN = 4; // rough estimate

function isSkippedPath(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts.some(part => SKIP_DIRS.includes(part));
}

function isSkippedFile(filePath) {
  const basename = path.basename(filePath);
  return SKIP_FILES.includes(basename) || basename.startsWith('.');
}

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (ext === '' || ext === '.') {
    const basename = path.basename(filePath).toLowerCase();
    return ['readme', 'license', 'makefile', 'dockerfile', 'procfile', '.env'].some(
      name => basename === name || basename.startsWith(name)
    );
  }
  return false;
}

function isImageFile(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function buildManifestFromZip(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const parts = [];
  const fileList = [];

  const priority = ['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.js', '.ts', '.css', '.json', '.md'];
  const sorted = [...entries].sort((a, b) => {
    const extA = path.extname(a.entryName).toLowerCase();
    const extB = path.extname(b.entryName).toLowerCase();
    const pA = priority.indexOf(extA);
    const pB = priority.indexOf(extB);
    return (pA === -1 ? 99 : pA) - (pB === -1 ? 99 : pB);
  });

  for (const entry of sorted) {
    if (entry.isDirectory) continue;

    const filePath = entry.entryName;
    if (isSkippedPath(filePath)) continue;
    if (isSkippedFile(filePath)) continue;

    const data = entry.getData();

    if (isImageFile(filePath) && data.length <= MAX_BASE64_IMAGE_SIZE) {
      const b64 = data.toString('base64');
      parts.push(`=== FILE (base64): ${filePath} ===\n${b64}`);
      fileList.push({ path: filePath, size: data.length, type: 'image-base64' });
      continue;
    }

    if (isImageFile(filePath)) {
      fileList.push({ path: filePath, size: data.length, type: 'image-skipped' });
      continue;
    }

    if (!isTextFile(filePath)) continue;

    try {
      const text = data.toString('utf-8');
      if (text.includes('\0')) continue; // binary check
      parts.push(`=== FILE: ${filePath} ===\n${text}`);
      fileList.push({ path: filePath, size: data.length, type: 'text' });
    } catch {
      // skip unreadable files
    }
  }

  if (parts.length === 0) {
    throw new Error('No readable source files found in the archive');
  }

  const manifest = parts.join('\n\n');
  const tokenEstimate = estimateTokens(manifest);

  if (tokenEstimate > MAX_MANIFEST_TOKENS) {
    throw new Error(
      `Project too large for conversion (estimated ${tokenEstimate.toLocaleString()} tokens, max ${MAX_MANIFEST_TOKENS.toLocaleString()})`
    );
  }

  return { manifest, fileList, tokenEstimate };
}

function buildManifestFromSingleFile(filename, buffer) {
  const content = buffer.toString('utf-8');
  const manifest = `=== FILE: ${filename} ===\n${content}`;
  const tokenEstimate = estimateTokens(manifest);

  if (tokenEstimate > MAX_MANIFEST_TOKENS) {
    throw new Error(
      `File too large for conversion (estimated ${tokenEstimate.toLocaleString()} tokens, max ${MAX_MANIFEST_TOKENS.toLocaleString()})`
    );
  }

  return {
    manifest,
    fileList: [{ path: filename, size: buffer.length, type: 'text' }],
    tokenEstimate,
  };
}

function buildManifestFromMultipleFiles(files) {
  const parts = [];
  const fileList = [];

  for (const file of files) {
    const ext = path.extname(file.originalname).toLowerCase();

    if (isImageFile(file.originalname) && file.size <= MAX_BASE64_IMAGE_SIZE) {
      const b64 = file.buffer.toString('base64');
      parts.push(`=== FILE (base64): ${file.originalname} ===\n${b64}`);
      fileList.push({ path: file.originalname, size: file.size, type: 'image-base64' });
      continue;
    }

    if (isImageFile(file.originalname)) {
      fileList.push({ path: file.originalname, size: file.size, type: 'image-skipped' });
      continue;
    }

    const content = file.buffer.toString('utf-8');
    parts.push(`=== FILE: ${file.originalname} ===\n${content}`);
    fileList.push({ path: file.originalname, size: file.size, type: 'text' });
  }

  if (parts.length === 0) {
    throw new Error('No readable source files found in the uploaded files');
  }

  const manifest = parts.join('\n\n');
  const tokenEstimate = estimateTokens(manifest);

  if (tokenEstimate > MAX_MANIFEST_TOKENS) {
    throw new Error(
      `Project too large for conversion (estimated ${tokenEstimate.toLocaleString()} tokens, max ${MAX_MANIFEST_TOKENS.toLocaleString()})`
    );
  }

  return { manifest, fileList, tokenEstimate };
}

function processUpload(files) {
  if (!files || files.length === 0) {
    throw new Error('No files uploaded');
  }

  if (files.length === 1 && path.extname(files[0].originalname).toLowerCase() === '.zip') {
    return buildManifestFromZip(files[0].buffer);
  }

  if (files.length === 1) {
    return buildManifestFromSingleFile(files[0].originalname, files[0].buffer);
  }

  return buildManifestFromMultipleFiles(files);
}

module.exports = {
  processUpload,
  buildManifestFromZip,
  buildManifestFromSingleFile,
  buildManifestFromMultipleFiles,
  estimateTokens,
};

const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM = process.env.EMAIL_FROM || 'AppHub <onboarding@resend.dev>';
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

async function send({ to, subject, html }) {
  if (!resend) {
    console.log(`[email] (no RESEND_API_KEY) To: ${to} | Subject: ${subject}`);
    return;
  }

  try {
    await resend.emails.send({ from: FROM, to, subject, html });
  } catch (err) {
    console.error(`[email] Failed to send to ${to}:`, err.message);
  }
}

// ── Password reset ──────────────────────────────────────────────────────────

function sendPasswordReset({ to, resetLink }) {
  return send({
    to,
    subject: 'Reset your AppHub password',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <h2 style="color: #1d1d1f; font-size: 22px; margin-bottom: 8px;">Reset your password</h2>
        <p style="color: #48484a; font-size: 15px; line-height: 1.6;">
          Someone requested a password reset for your AppHub account. Click the button below to set a new password.
        </p>
        <a href="${resetLink}" style="display: inline-block; background: #e94560; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 500; font-size: 15px; margin: 20px 0;">
          Reset Password
        </a>
        <p style="color: #8e8e93; font-size: 13px; line-height: 1.6;">
          This link expires in 1 hour. If you didn't request this, you can safely ignore this email.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e5e7; margin: 24px 0;" />
        <p style="color: #8e8e93; font-size: 12px;">AppHub — your team's app portal</p>
      </div>
    `,
  });
}

// ── Workspace invite ────────────────────────────────────────────────────────

function sendInvite({ to, workspaceName, inviteLink, invitedBy }) {
  return send({
    to,
    subject: `You've been invited to ${workspaceName} on AppHub`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <h2 style="color: #1d1d1f; font-size: 22px; margin-bottom: 8px;">You're invited!</h2>
        <p style="color: #48484a; font-size: 15px; line-height: 1.6;">
          ${invitedBy ? `<strong>${invitedBy}</strong> has invited you` : 'You\'ve been invited'} to join <strong>${workspaceName}</strong> on AppHub.
        </p>
        <a href="${inviteLink}" style="display: inline-block; background: #e94560; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 500; font-size: 15px; margin: 20px 0;">
          Join ${workspaceName}
        </a>
        <p style="color: #8e8e93; font-size: 13px; line-height: 1.6;">
          Or sign in at <a href="${CLIENT_URL}/login" style="color: #e94560;">${CLIENT_URL}/login</a> with this email address.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e5e7; margin: 24px 0;" />
        <p style="color: #8e8e93; font-size: 12px;">AppHub — your team's app portal</p>
      </div>
    `,
  });
}

// ── Welcome email ───────────────────────────────────────────────────────────

function sendWelcome({ to, displayName, workspaceName }) {
  return send({
    to,
    subject: `Welcome to AppHub${workspaceName ? ` — ${workspaceName}` : ''}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <h2 style="color: #1d1d1f; font-size: 22px; margin-bottom: 8px;">Welcome to AppHub, ${displayName}! 🚀</h2>
        <p style="color: #48484a; font-size: 15px; line-height: 1.6;">
          ${workspaceName ? `Your workspace <strong>${workspaceName}</strong> is ready.` : 'Your account is ready.'} Here's how to get started:
        </p>
        <ol style="color: #48484a; font-size: 15px; line-height: 2; padding-left: 20px;">
          <li><strong>Build</strong> an HTML app with any AI tool (Claude, ChatGPT, etc.)</li>
          <li><strong>Upload</strong> the HTML file to AppHub</li>
          <li><strong>Share</strong> it with your team instantly</li>
        </ol>
        <a href="${CLIENT_URL}" style="display: inline-block; background: #e94560; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 500; font-size: 15px; margin: 20px 0;">
          Open AppHub
        </a>
        <hr style="border: none; border-top: 1px solid #e5e5e7; margin: 24px 0;" />
        <p style="color: #8e8e93; font-size: 12px;">AppHub — your team's app portal</p>
      </div>
    `,
  });
}

module.exports = { sendPasswordReset, sendInvite, sendWelcome };

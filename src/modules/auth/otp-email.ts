export type CodePurpose = 'signup' | 'reset';

const INTRO: Record<CodePurpose, string> = {
  signup: 'Use this code to create your EssentiallyAnalytics account:',
  reset: 'Use this code to reset your EssentiallyAnalytics password:',
};

/**
 * Deliberately plain: inline styles only, no images and no tracking pixel.
 * Anything fancier hurts deliverability and adds nothing to a 6-digit code.
 */
export function otpEmail(code: string, minutes: number, purpose: CodePurpose) {
  const subject = `${code} is your EssentiallyAnalytics verification code`;
  const text = [
    INTRO[purpose],
    '',
    `    ${code}`,
    '',
    `It expires in ${minutes} minutes and can only be used once.`,
    '',
    "If you didn't request this, you can ignore this email — nothing has changed.",
    'Nobody from the team will ever ask you for this code.',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#12181c">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #d9dee1;border-radius:6px;padding:28px">
<p style="margin:0 0 18px;font-size:15px;line-height:1.5">${INTRO[purpose]}</p>
<p style="margin:0 0 18px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:6px">${code}</p>
<p style="margin:0 0 10px;font-size:13px;color:#5d6b72;line-height:1.5">Expires in ${minutes} minutes. Single use.</p>
<p style="margin:0;font-size:13px;color:#5d6b72;line-height:1.5">If you didn't request this, ignore this email — nothing has changed. Nobody from the team will ever ask you for this code.</p>
</div></body></html>`;
  return { subject, text, html };
}

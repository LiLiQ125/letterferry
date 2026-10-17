import qrcode from 'qrcode-terminal';

export function renderTerminalQr(content, renderer = qrcode) {
  if (typeof content !== 'string' || !content) throw new Error('INVALID_QR_CONTENT');
  let rendered;
  renderer.generate(content, { small: true }, (value) => { rendered = value; });
  if (typeof rendered !== 'string' || !rendered.trim()) throw new Error('QR_RENDER_FAILED');
  return rendered;
}

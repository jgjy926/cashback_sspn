// Gateway connection settings, shared by sync, ocr and receipts.
// Stored client-side only; the actual secrets live on the Cloudflare Worker.
export function gatewayConfig() {
  return {
    base: (localStorage.getItem('koofr_endpoint') || '').trim().replace(/\/+$/, ''),
    token: (localStorage.getItem('koofr_token') || '').trim(),
  };
}

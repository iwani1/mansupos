export class AppError extends Error {
  constructor(message, status = 400, code = 'REQUEST_ERROR') { super(message); this.status = status; this.code = code; }
}
export class RemoteError extends AppError {
  constructor(message, status = 502, uncertain = false) { super(message, status, 'WOOCOMMERCE_ERROR'); this.uncertain = uncertain; }
}
export const now = () => new Date().toISOString();

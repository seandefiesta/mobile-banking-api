export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (message = 'Resource not found') =>
  new HttpError(404, 'not_found', message);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'unauthorized', message);
export const validationError = (details) =>
  new HttpError(422, 'validation_error', 'Request validation failed', details);

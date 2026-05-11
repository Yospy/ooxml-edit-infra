export function badRequest(code: string, message: string) {
  return httpError(400, code, message);
}

export function notFound(code: string, message: string) {
  return httpError(404, code, message);
}

export function conflict(code: string, message: string) {
  return httpError(409, code, message);
}

export function httpError(statusCode: number, code: string, message: string) {
  const error = new Error(message) as Error & {
    statusCode: number;
    code: string;
  };
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

export class AppError extends Error {
  constructor(
    public code: string,
    public statusCode = 400,
  ) {
    super(code);
  }
}
export function ensure(ok: unknown, code: string, status = 400): asserts ok {
  if (!ok) throw new AppError(code, status);
}
export const unavailable = () => new AppError('TARGET_UNAVAILABLE', 404);

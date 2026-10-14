export class AppError extends Error {
  constructor(
    public code: string,
    public status: number = 400,
  ) {
    super(code);
  }
}

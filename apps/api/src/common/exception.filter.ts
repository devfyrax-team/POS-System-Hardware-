import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { AppError } from './errors';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (exception instanceof AppError) {
      return res.status(exception.getStatus()).json({
        code: exception.code,
        message: exception.message,
        details: exception.details,
      });
    }
    if (exception instanceof HttpException) {
      const body: any = exception.getResponse();
      return res.status(exception.getStatus()).json({
        code: 'HTTP_ERROR',
        message: typeof body === 'string' ? body : body.message ?? exception.message,
      });
    }
    this.log.error(exception instanceof Error ? exception.stack : String(exception));
    return res.status(500).json({ code: 'INTERNAL', message: 'Internal server error' });
  }
}

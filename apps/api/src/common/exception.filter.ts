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
    // Body-parser errors (too large, malformed JSON) carry their own 4xx status
    const http = (exception as { status?: number; statusCode?: number; type?: string }) ?? {};
    const st = http.status ?? http.statusCode;
    if (typeof st === 'number' && st >= 400 && st < 500) {
      return res.status(st).json({ code: st === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', message: st === 413 ? 'Request body is too large' : 'Malformed request' });
    }
    // Database errors that are really bad requests (never leak SQL text to the client)
    const pg = exception as { code?: string };
    if (pg?.code === '22P02' || pg?.code === '22003' || pg?.code === '22007' || pg?.code === '22021') {
      return res.status(400).json({ code: 'VALIDATION', message: 'Invalid value in the request' });
    }
    if (pg?.code === '23503') return res.status(409).json({ code: 'CONFLICT', message: 'The record refers to something that does not exist or is still in use' });
    if (pg?.code === '23505') return res.status(409).json({ code: 'CONFLICT', message: 'That value already exists' });
    if (pg?.code === '40001' || pg?.code === '40P01') return res.status(503).json({ code: 'RETRY', message: 'Busy, please retry' });
    this.log.error(exception instanceof Error ? exception.stack : String(exception));
    return res.status(500).json({ code: 'INTERNAL', message: 'Internal server error' });
  }
}

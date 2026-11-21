import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './common/bootstrap';

async function bootstrap() {
  // body parsing is configured in configureApp (with size limits)
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/ready', 'docs'] });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}
bootstrap();

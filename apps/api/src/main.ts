import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app';
import { readConfig } from './config';
async function bootstrap(){const cfg=readConfig();const app=await NestFactory.create(AppModule,{logger:false});configureApp(app,cfg.CORS_ORIGINS.split(',').map(s=>s.trim()));await app.listen(cfg.API_PORT,cfg.API_HOST);console.info('CaissePro API démarrée.');}
void bootstrap().catch(()=>{console.error('Démarrage impossible. Vérifier PostgreSQL, les migrations et la configuration.');process.exitCode=1;});

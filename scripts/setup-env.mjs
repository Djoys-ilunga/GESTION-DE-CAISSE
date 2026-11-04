import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const target = new URL('../.env', import.meta.url);
try {
  const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8').replaceAll(
    'REMPLACER_PAR_UN_MOT_DE_PASSE_LOCAL_ALEATOIRE',
    randomBytes(24).toString('hex'),
  ).replaceAll('GENERER_PAR_SETUP_ENV',randomBytes(32).toString('hex'));
  writeFileSync(target, text, { flag: 'wx', mode: 0o600 });
  console.info('.env local créé, sans affichage de secret.');
} catch (error) {
  if (error?.code === 'EEXIST') {
    const existing=readFileSync(target,'utf8');
    if(!/^AUTH_RATE_LIMIT_SECRET=/m.test(existing)) appendFileSync(target,'\nAUTH_RATE_LIMIT_SECRET='+randomBytes(32).toString('hex')+'\n',{mode:0o600});
    else if(existing.includes('AUTH_RATE_LIMIT_SECRET=GENERER_PAR_SETUP_ENV')) writeFileSync(target,existing.replace('AUTH_RATE_LIMIT_SECRET=GENERER_PAR_SETUP_ENV','AUTH_RATE_LIMIT_SECRET='+randomBytes(32).toString('hex')),{mode:0o600});
    console.info('.env préservé ; configuration de sécurité complétée sans affichage de secret.');
  }
  else {
    console.error('Création .env impossible.');
    process.exitCode = 1;
  }
}

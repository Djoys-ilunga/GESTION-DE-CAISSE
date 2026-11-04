import { randomBytes } from 'node:crypto';
import { readFileSync,writeFileSync } from 'node:fs';
const target=new URL('../.env',import.meta.url);
try {
  const text=readFileSync(new URL('../.env.example',import.meta.url),'utf8').replaceAll('REMPLACER_PAR_UN_MOT_DE_PASSE_LOCAL_ALEATOIRE',randomBytes(24).toString('hex'));
  writeFileSync(target,text,{flag:'wx',mode:0o600});console.info('.env local créé, sans affichage de secret.');
} catch(error) {
  if(error?.code==='EEXIST')console.info('.env existant préservé.');
  else {console.error('Création .env impossible.');process.exitCode=1;}
}

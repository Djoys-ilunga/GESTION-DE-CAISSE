-- Stage 12: schema evolution only. No UPDATE of posted monetary values or snapshots.
BEGIN;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtext('caissepro-currency-schema-v2'));
CREATE TEMP TABLE cp_currency_constraints ON COMMIT DROP AS
 SELECT conrelid::regclass::text AS relation,conname,contype,pg_get_constraintdef(oid) AS definition
 FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype IN('f','c');
CREATE TEMP TABLE cp_currency_views ON COMMIT DROP AS
 SELECT relname,pg_get_viewdef(oid) AS definition,pg_get_userbyid(relowner) AS owner,coalesce(relacl,acldefault('r',relowner)) AS acl FROM pg_class
 WHERE relnamespace='public'::regnamespace AND relname IN('AccountBalance','AvailableFunds');
DROP VIEW "AvailableFunds";
DROP VIEW "AccountBalance";
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM cp_currency_constraints LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.relation,r.conname); END LOOP;
END $$;
-- The sole historical function with a Currency argument is rebound to a text domain.
DROP FUNCTION caissepro_assert_expense_limit(uuid,uuid,"Currency",text,numeric);
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT c.oid::regclass AS relation,a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND a.atttypid='"Currency"'::regtype LOOP
  EXECUTE format('ALTER TABLE %s ALTER COLUMN %I TYPE text USING %I::text',r.relation,r.attname,r.attname);
 END LOOP;
 FOR r IN SELECT c.oid::regclass AS relation,a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='numeric(18,2)' LOOP
  EXECUTE format('ALTER TABLE %s ALTER COLUMN %I TYPE numeric(24,8)',r.relation,r.attname);
 END LOOP;
END $$;
DROP TYPE "Currency";
-- Compatibility for existing SQL argument casts; column identifiers are data-driven text.
CREATE DOMAIN "Currency" AS text CHECK(VALUE~'^[A-Z]{3}$');
CREATE TABLE "CurrencyDefinition"(code text PRIMARY KEY CHECK(code~'^[A-Z]{3}$'),"numericCode" varchar(3) NOT NULL CHECK("numericCode"~'^[0-9]{3}$'),name varchar(160) NOT NULL,symbol varchar(20) NOT NULL,"precision" integer NOT NULL CHECK("precision" BETWEEN 0 AND 4),active boolean NOT NULL DEFAULT true,"bccRateStatus" varchar(16) NOT NULL DEFAULT 'UNVERIFIED' CHECK("bccRateStatus" IN('UNVERIFIED','AVAILABLE','UNAVAILABLE')),"sourceDate" varchar(10) NOT NULL);
INSERT INTO "CurrencyDefinition" VALUES ('AED','784','dirham des Émirats arabes unis','AED',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('AFN','971','afghani afghan','؋',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('ALL','008','lek albanais','ALL',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('AMD','051','dram arménien','֏',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('ANG','532','florin antillais','ANG',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('AOA','973','kwanza angolais','Kz',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('ARS','032','peso argentin','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('AUD','036','dollar australien','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('AWG','533','florin arubais','AWG',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('AZN','944','manat azéri','₼',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('BAM','977','mark convertible bosniaque','KM',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('BBD','052','dollar barbadien','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('BDT','050','taka bangladeshi','৳',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('BGN','975','lev bulgare','BGN',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('BHD','048','dinar bahreïni','BHD',3,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('BIF','108','franc burundais','BIF',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('BMD','060','dollar bermudien','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('BND','096','dollar brunéien','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('BOB','068','boliviano bolivien','Bs',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('BOV','984','mvdol bolivien','BOV',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('BRL','986','réal brésilien','R$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('BSD','044','dollar bahaméen','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('BTN','064','ngultrum bouthanais','BTN',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('BWP','072','pula botswanais','P',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('BYN','933','rouble biélorusse','р.',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('BZD','084','dollar bélizéen','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('CAD','124','dollar canadien','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('CDF','976','franc congolais','CDF',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('CHE','947','euro WIR','CHE',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('CHF','756','franc suisse','CHF',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('CHW','948','franc WIR','CHW',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('CLF','990','unité d’investissement chilienne','CLF',4,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('CLP','152','peso chilien','$',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('CNY','156','yuan renminbi chinois','¥',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('COP','170','peso colombien','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('COU','970','unité de valeur réelle colombienne','COU',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('CRC','188','colón costaricain','₡',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('CUC','931','peso cubain convertible','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('CUP','192','peso cubain','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('CVE','132','escudo capverdien','CVE',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('CZK','203','couronne tchèque','Kč',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('DJF','262','franc djiboutien','DJF',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('DKK','208','couronne danoise','kr',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('DOP','214','peso dominicain','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('DZD','012','dinar algérien','DZD',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('EGP','818','livre égyptienne','£E',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('ERN','232','nafka érythréen','ERN',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('ETB','230','birr éthiopien','ETB',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('EUR','978','euro','€',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('FJD','242','dollar fidjien','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('FKP','238','livre des îles Malouines','£',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('GBP','826','livre sterling','£',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('GEL','981','lari géorgien','₾',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('GHS','936','cédi ghanéen','GH₵',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('GIP','292','livre de Gibraltar','£',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('GMD','270','dalasi gambien','GMD',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('GNF','324','franc guinéen','FG',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('GTQ','320','quetzal guatémaltèque','Q',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('GYD','328','dollar du Guyana','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('HKD','344','dollar de Hong Kong','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('HNL','340','lempira hondurien','L',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('HTG','332','gourde haïtienne','HTG',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('HUF','348','forint hongrois','Ft',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('IDR','360','roupie indonésienne','Rp',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('ILS','376','nouveau shekel israélien','₪',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('INR','356','roupie indienne','₹',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('IQD','368','dinar irakien','IQD',3,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('IRR','364','riyal iranien','IRR',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('ISK','352','couronne islandaise','kr',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('JMD','388','dollar jamaïcain','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('JOD','400','dinar jordanien','JOD',3,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('JPY','392','yen japonais','¥',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('KES','404','shilling kényan','KES',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('KGS','417','som kirghize','⃀',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('KHR','116','riel cambodgien','៛',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('KMF','174','franc comorien','FC',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('KPW','408','won nord-coréen','₩',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('KRW','410','won sud-coréen','₩',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('KWD','414','dinar koweïtien','KWD',3,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('KYD','136','dollar des îles Caïmans','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('KZT','398','tenge kazakh','₸',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('LAK','418','kip laotien','₭',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('LBP','422','livre libanaise','£L',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('LKR','144','roupie srilankaise','Rs',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('LRD','430','dollar libérien','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('LSL','426','loti lesothan','LSL',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('LYD','434','dinar libyen','LYD',3,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('MAD','504','dirham marocain','MAD',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('MDL','498','leu moldave','MDL',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('MGA','969','ariary malgache','Ar',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('MKD','807','denar macédonien','MKD',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('MMK','104','kyat myanmarais','K',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('MNT','496','tugrik mongol','₮',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('MOP','446','pataca macanaise','MOP',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('MRU','929','ouguiya mauritanien','MRU',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('MUR','480','roupie mauricienne','Rs',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('MVR','462','rufiyaa maldivienne','MVR',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('MWK','454','kwacha malawite','MWK',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('MXN','484','peso mexicain','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('MXV','979','unité de conversion mexicaine (UDI)','MXV',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('MYR','458','ringgit malais','RM',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('MZN','943','metical mozambicain','MZN',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('NAD','516','dollar namibien','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('NGN','566','naira nigérian','₦',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('NIO','558','córdoba oro nicaraguayen','$C',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('NOK','578','couronne norvégienne','kr',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('NPR','524','roupie népalaise','Rs',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('NZD','554','dollar néo-zélandais','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('OMR','512','riyal omanais','OMR',3,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('PAB','590','balboa panaméen','PAB',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('PEN','604','sol péruvien','PEN',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('PGK','598','kina papouan-néo-guinéen','PGK',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('PHP','608','peso philippin','₱',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('PKR','586','roupie pakistanaise','Rs',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('PLN','985','zloty polonais','zł',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('PYG','600','guaraní paraguayen','₲',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('QAR','634','riyal qatari','QAR',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('RON','946','leu roumain','L',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('RSD','941','dinar serbe','RSD',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('RUB','643','rouble russe','₽',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('RWF','646','franc rwandais','FR',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('SAR','682','riyal saoudien','SAR',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('SBD','090','dollar des îles Salomon','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('SCR','690','roupie des Seychelles','SCR',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('SDG','938','livre soudanaise','SDG',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('SEK','752','couronne suédoise','kr',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('SGD','702','dollar de Singapour','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('SHP','654','livre de Sainte-Hélène','£',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('SLE','925','leone sierra-léonais','SLE',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('SOS','706','shilling somalien','SOS',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('SRD','968','dollar surinamais','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('SSP','728','livre sud-soudanaise','£',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('STN','930','dobra santoméen','Db',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('SVC','222','colón salvadorien','SVC',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('SYP','760','livre syrienne','£',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('SZL','748','lilangeni swazi','SZL',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('THB','764','baht thaïlandais','฿',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('TJS','972','somoni tadjik','TJS',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('TMT','934','nouveau manat turkmène','TMT',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('TND','788','dinar tunisien','TND',3,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('TOP','776','pa’anga tongan','$T',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('TRY','949','livre turque','₺',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('TTD','780','dollar de Trinité-et-Tobago','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('TWD','901','nouveau dollar taïwanais','NT$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('TZS','834','shilling tanzanien','TZS',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('UAH','980','hryvnia ukrainienne','₴',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('UGX','800','shilling ougandais','UGX',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('USD','840','dollar des États-Unis','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('USN','997','dollar des Etats-Unis (jour suivant)','USN',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('UYI','940','peso uruguayen (unités indexées)','UYI',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('UYU','858','peso uruguayen','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('UYW','927','UYW','UYW',4,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('UZS','860','sum ouzbek','UZS',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('VED','926','VED','VED',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('VES','928','bolivar vénézuélien','VES',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('VND','704','dông vietnamien','₫',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('VUV','548','vatu vanuatuan','VUV',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('WST','882','tala samoan','$WS',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('XAF','950','franc CFA (BEAC)','FCFA',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('XCD','951','dollar des Caraïbes orientales','$',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('XOF','952','franc CFA (BCEAO)','F CFA',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('XPF','953','franc CFP','FCFP',0,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('YER','886','riyal yéménite','YER',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('ZAR','710','rand sud-africain','R',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('ZMW','967','kwacha zambien','Kw',2,true,'UNVERIFIED','2024-06-25');
INSERT INTO "CurrencyDefinition" VALUES ('ZWG','924','or du Zimbabwe','ZWG',2,true,'UNVERIFIED','2024-06-25');

CREATE TABLE "CompanyCurrency"("companyId" uuid NOT NULL REFERENCES "Company"(id),code text NOT NULL REFERENCES "CurrencyDefinition"(code),active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),PRIMARY KEY("companyId",code));
CREATE TABLE "CompanyMonetarySettings"("companyId" uuid PRIMARY KEY REFERENCES "Company"(id),"reportingCurrency" text,version integer NOT NULL DEFAULT 1 CHECK(version>0),FOREIGN KEY("companyId","reportingCurrency") REFERENCES "CompanyCurrency"("companyId",code));
CREATE TABLE "UserMoneyPreference"("companyId" uuid NOT NULL,"userId" uuid NOT NULL,"displayCurrency" text,"favoriteCurrency" text,locale varchar(10) NOT NULL DEFAULT 'fr-FR' CHECK(locale IN('fr-FR','fr-CD','en-US','en-GB')),version integer NOT NULL DEFAULT 1 CHECK(version>0),PRIMARY KEY("companyId","userId"),FOREIGN KEY("companyId","userId") REFERENCES "CompanyMember"("companyId","userId"),FOREIGN KEY("companyId","displayCurrency") REFERENCES "CompanyCurrency"("companyId",code),FOREIGN KEY("companyId","favoriteCurrency") REFERENCES "CompanyCurrency"("companyId",code));
INSERT INTO "CompanyCurrency" SELECT id,c,true,1 FROM "Company" CROSS JOIN unnest(ARRAY['CDF','USD']) c;
INSERT INTO "CompanyMonetarySettings"("companyId") SELECT id FROM "Company";
GRANT SELECT ON "CurrencyDefinition" TO caissepro_runtime,caissepro_auth_runtime;
CREATE FUNCTION caissepro_currency_precision(c text) RETURNS integer LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$ DECLARE p integer; BEGIN SELECT "precision" INTO p FROM "CurrencyDefinition" WHERE code=c; IF p IS NULL THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_UNKNOWN'; END IF; RETURN p; END $$;
CREATE FUNCTION caissepro_currency_round(v numeric,c text) RETURNS numeric LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$ SELECT round(v,caissepro_currency_precision(c)) $$;
CREATE FUNCTION caissepro_money_text(v numeric,c text) RETURNS text LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$ SELECT caissepro_currency_round(v,c)::text $$;
CREATE FUNCTION caissepro_money_input_valid(v text,c text) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$ DECLARE p integer:=caissepro_currency_precision(c); BEGIN
 IF v IS NULL OR v!~'^(0|[1-9][0-9]{0,15})(\.[0-9]{1,4})?$' THEN RETURN false; END IF;
 RETURN (CASE WHEN p=0 THEN position('.' in v)=0 ELSE position('.' in v)>0 AND length(split_part(v,'.',2))=p END);
END $$;
DO $$ DECLARE r record; permission record; BEGIN
 FOR r IN SELECT * FROM cp_currency_constraints ORDER BY contype LOOP
  IF r.relation='"TransferOrder"' AND r.definition LIKE '%round(%' THEN
   r.definition:='CHECK (("sourceCurrency"="destinationCurrency" AND rate IS NULL AND "rateSource"='''' AND amount="targetAmount") OR ("sourceCurrency"<>"destinationCurrency" AND rate IS NOT NULL AND rate>0 AND length(trim("rateSource"))>0 AND "targetAmount"=caissepro_currency_round(amount*rate,"destinationCurrency")))';
  END IF;
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',r.relation,r.conname,r.definition);
 END LOOP;
 FOR r IN SELECT * FROM cp_currency_views ORDER BY CASE relname WHEN 'AccountBalance' THEN 0 ELSE 1 END LOOP
  EXECUTE format('CREATE VIEW %I WITH(security_invoker=true) AS %s',r.relname,r.definition);
  FOR permission IN SELECT e.*,p.rolname FROM aclexplode(r.acl) e LEFT JOIN pg_roles p ON p.oid=e.grantee LOOP
   EXECUTE format('GRANT %s ON %I TO %s%s',permission.privilege_type,r.relname,CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(permission.rolname) END,CASE WHEN permission.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  EXECUTE format('ALTER VIEW %I OWNER TO %I',r.relname,r.owner);
 END LOOP;
END $$;
GRANT SELECT ON "AccountBalance","AvailableFunds" TO caissepro_runtime;
-- Every code-bearing column references the catalog, including historical documents.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN('currency','sourceCurrency','destinationCurrency','fromCurrency','toCurrency') AND table_name NOT IN('AccountBalance','AvailableFunds') LOOP
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(%I) REFERENCES "CurrencyDefinition"(code)',r.table_name,r.table_name||'_'||r.column_name||'_catalog_fk',r.column_name);
 END LOOP;
END $$;
CREATE FUNCTION caissepro_company_currency_defaults() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE previous text:=current_setting('caissepro.company_id',true); BEGIN
 PERFORM set_config('caissepro.company_id',NEW.id::text,true);
 INSERT INTO "CompanyCurrency" VALUES(NEW.id,'CDF',true,1),(NEW.id,'USD',true,1);
 INSERT INTO "CompanyMonetarySettings"("companyId") VALUES(NEW.id);
 PERFORM set_config('caissepro.company_id',coalesce(previous,''),true); RETURN NEW;
END $$;
CREATE TRIGGER monetary_defaults AFTER INSERT ON "Company" FOR EACH ROW EXECUTE FUNCTION caissepro_company_currency_defaults();
CREATE FUNCTION caissepro_currency_active(c uuid,cur text) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 PERFORM 1 FROM "CompanyCurrency" cc JOIN "CurrencyDefinition" d ON d.code=cc.code WHERE cc."companyId"=c AND cc.code=cur AND cc.active AND d.active FOR SHARE OF cc;
 IF NOT FOUND THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_INACTIVE'; END IF;
END $$;
CREATE FUNCTION caissepro_currency_record_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE j jsonb:=to_jsonb(NEW); cur text; k text; val numeric; r "ExchangeRate"; reversal boolean:=false; BEGIN
 IF TG_TABLE_NAME='FinancialOperation' THEN reversal:=j->>'kind'='REVERSAL'; END IF;
 IF TG_TABLE_NAME='LedgerEntry' THEN SELECT kind='REVERSAL' INTO reversal FROM "FinancialOperation" WHERE id=NEW."operationId"; END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN('ExpenseRequest','FundReservation') AND j->>'state' IN('REJECTED','CANCELLED','RELEASED') THEN RETURN NEW; END IF;
 FOR k,cur IN SELECT key,value FROM jsonb_each_text(j) WHERE key IN('currency','sourceCurrency','destinationCurrency','fromCurrency','toCurrency') AND value IS NOT NULL LOOP
  IF NOT reversal AND NOT (TG_TABLE_NAME='ExpenseApproval' AND j->>'decision'='REJECT') THEN PERFORM caissepro_currency_active((j->>'companyId')::uuid,cur); END IF;
 END LOOP;
 IF j->>'currency' IS NOT NULL AND j->>'amount' IS NOT NULL THEN
  val:=(j->>'amount')::numeric; IF abs(val)>=10000000000000000 OR val<>caissepro_currency_round(val,j->>'currency') THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_PRECISION'; END IF;
 END IF;
 IF TG_TABLE_NAME='TransferOrder' THEN
  IF NEW.amount<>caissepro_currency_round(NEW.amount,NEW."sourceCurrency") OR NEW."targetAmount"<>caissepro_currency_round(NEW."targetAmount",NEW."destinationCurrency") OR NEW.amount>=10000000000000000 OR NEW."targetAmount">=10000000000000000 THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_PRECISION'; END IF;
 END IF;
 IF TG_TABLE_NAME='FinancialOperation' AND j->>'kind'='FX' THEN
  SELECT * INTO r FROM "ExchangeRate" WHERE id=NEW."exchangeRateId" AND "companyId"=NEW."companyId";
  IF NEW."sourceAmount"<>caissepro_currency_round(NEW."sourceAmount",r."fromCurrency") OR NEW."targetAmount"<>caissepro_currency_round(NEW."targetAmount",r."toCurrency") THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_PRECISION'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['TreasuryAccount','FinancialOperation','LedgerEntry','ExpenseRequest','ExpenseApproval','FundReservation','Transfer','ExchangeRate','ImportedDraft','CashReceipt','PaymentVoucher','TransferOrder','ReferenceExchangeRate','ExpensePolicy'] LOOP
 EXECUTE format('CREATE TRIGGER currency_record_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION caissepro_currency_record_guard()',t);
 END LOOP;
END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['TransferOrder','ImportedDraft','ExpensePolicy'] LOOP EXECUTE format('CREATE TRIGGER currency_record_guard_update BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION caissepro_currency_record_guard()',t); END LOOP; END $$;
CREATE FUNCTION caissepro_currency_metadata_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.code IS DISTINCT FROM OLD.code OR NEW."precision" IS DISTINCT FROM OLD."precision" THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_METADATA_IMMUTABLE'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER currency_metadata_guard BEFORE UPDATE OR DELETE ON "CurrencyDefinition" FOR EACH ROW EXECUTE FUNCTION caissepro_currency_metadata_guard();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['CompanyCurrency','CompanyMonetarySettings','UserMoneyPreference'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY monetary_tenant ON %I TO caissepro_runtime,caissepro_auth_runtime USING("companyId"=nullif(current_setting(''caissepro.company_id'',true),'''')::uuid) WITH CHECK("companyId"=nullif(current_setting(''caissepro.company_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE POLICY preference_owner ON "UserMoneyPreference" AS RESTRICTIVE TO caissepro_runtime,caissepro_auth_runtime USING("userId"=nullif(current_setting('caissepro.actor_id',true),'')::uuid) WITH CHECK("userId"=nullif(current_setting('caissepro.actor_id',true),'')::uuid);
GRANT SELECT ON "CompanyCurrency","CompanyMonetarySettings","UserMoneyPreference" TO caissepro_runtime,caissepro_auth_runtime;
GRANT INSERT,UPDATE ON "CompanyCurrency","CompanyMonetarySettings","UserMoneyPreference" TO caissepro_auth_runtime,caissepro_runtime;
CREATE FUNCTION caissepro_currency_in_use(c uuid,cur text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET row_security=on AS $$
 SELECT c=nullif(current_setting('caissepro.company_id',true),'')::uuid AND (EXISTS(SELECT FROM "FundReservation" WHERE "companyId"=c AND currency=cur AND state='ACTIVE') OR EXISTS(SELECT FROM "TransferOrder" WHERE "companyId"=c AND state='HANDED_OVER' AND ("sourceCurrency"=cur OR "destinationCurrency"=cur)))
$$;
GRANT SELECT ON "FundReservation" TO caissepro_transfer_reader;
CREATE POLICY monetary_reservations ON "FundReservation" FOR SELECT TO caissepro_transfer_reader USING("companyId"=nullif(current_setting('caissepro.company_id',true),'')::uuid);
GRANT CREATE ON SCHEMA public TO caissepro_transfer_reader;
ALTER FUNCTION caissepro_currency_in_use(uuid,text) OWNER TO caissepro_transfer_reader;
REVOKE CREATE ON SCHEMA public FROM caissepro_transfer_reader;
REVOKE ALL ON FUNCTION caissepro_currency_in_use(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION caissepro_currency_in_use(uuid,text) TO caissepro_runtime,caissepro_auth_runtime;
CREATE FUNCTION caissepro_monetary_configuration_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE actor uuid:=nullif(current_setting('caissepro.actor_id',true),'')::uuid; BEGIN
 IF current_user IN('caissepro_runtime','caissepro_auth_runtime') THEN
  PERFORM caissepro_assert_session(NEW."companyId",actor);
  IF TG_TABLE_NAME='UserMoneyPreference' THEN
   IF NEW."userId" IS DISTINCT FROM actor OR NOT EXISTS(SELECT FROM "CompanyMember" WHERE "companyId"=NEW."companyId" AND "userId"=actor AND active) THEN RAISE EXCEPTION 'CAISSEPRO_ACCESS_DENIED'; END IF;
  ELSE PERFORM caissepro_assert_company_permission(NEW."companyId",actor,'cash:configure'); END IF;
 END IF;
 IF TG_OP='UPDATE' AND (NEW."companyId"<>OLD."companyId" OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'CAISSEPRO_SETTINGS_CONFLICT'; END IF;
 IF TG_TABLE_NAME='UserMoneyPreference' THEN
  IF TG_OP='UPDATE' AND NEW."userId"<>OLD."userId" THEN RAISE EXCEPTION 'CAISSEPRO_ACCESS_DENIED'; END IF;
  IF NEW."displayCurrency" IS NOT NULL THEN PERFORM caissepro_currency_active(NEW."companyId",NEW."displayCurrency"); END IF;
  IF NEW."favoriteCurrency" IS NOT NULL THEN PERFORM caissepro_currency_active(NEW."companyId",NEW."favoriteCurrency"); END IF;
 ELSIF TG_TABLE_NAME='CompanyMonetarySettings' THEN
  IF NEW."reportingCurrency" IS NOT NULL THEN PERFORM caissepro_currency_active(NEW."companyId",NEW."reportingCurrency"); END IF;
 ELSE
  IF TG_OP='UPDATE' AND NEW.code<>OLD.code THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_METADATA_IMMUTABLE'; END IF;
  IF NEW.active AND NOT EXISTS(SELECT FROM "CurrencyDefinition" WHERE code=NEW.code AND active) THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_INACTIVE'; END IF;
  IF NOT NEW.active THEN
   IF NOT EXISTS(SELECT FROM "CompanyCurrency" WHERE "companyId"=NEW."companyId" AND code<>NEW.code AND active) OR caissepro_currency_in_use(NEW."companyId",NEW.code) OR EXISTS(SELECT FROM "CompanyMonetarySettings" WHERE "companyId"=NEW."companyId" AND "reportingCurrency"=NEW.code) THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_IN_USE'; END IF;
  END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER monetary_configuration_guard BEFORE INSERT OR UPDATE ON "CompanyCurrency" FOR EACH ROW EXECUTE FUNCTION caissepro_monetary_configuration_guard();
CREATE TRIGGER monetary_configuration_guard BEFORE INSERT OR UPDATE ON "CompanyMonetarySettings" FOR EACH ROW EXECUTE FUNCTION caissepro_monetary_configuration_guard();
CREATE TRIGGER monetary_configuration_guard BEFORE INSERT OR UPDATE ON "UserMoneyPreference" FOR EACH ROW EXECUTE FUNCTION caissepro_monetary_configuration_guard();
CREATE OR REPLACE FUNCTION caissepro_assert_expense_limit(c uuid,u uuid,cur "Currency",act text,total numeric) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE pol "ExpensePolicy"; BEGIN
 SELECT * INTO pol FROM "ExpensePolicy" WHERE "companyId"=c AND currency=cur FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_POLICY_REQUIRED' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT FROM "CompanyMember" m JOIN "MemberRole" mr ON mr."companyId"=m."companyId" AND mr."memberId"=m.id JOIN "Role" r ON r."companyId"=mr."companyId" AND r.id=mr."roleId" JOIN "RolePermission" rp ON rp."companyId"=r."companyId" AND rp."roleId"=r.id CROSS JOIN LATERAL jsonb_array_elements(pol.limits) lim WHERE m."companyId"=c AND m."userId"=u AND m.active AND r.active AND lim->>'role'=r.code AND lim->>'action'=act AND (lim->>'maximum')::numeric>=total AND rp."permissionCode"=CASE act WHEN 'REQUEST' THEN 'expense:request' WHEN 'APPROVE' THEN 'expense:approve' WHEN 'PAY' THEN 'expense:pay' ELSE '' END) THEN RAISE EXCEPTION 'CAISSEPRO_EXPENSE_LIMIT_EXCEEDED' USING ERRCODE='42501'; END IF;
END $$;
CREATE OR REPLACE FUNCTION caissepro_check_operation(c uuid,op uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE o "FinancialOperation"; ex "ExpenseRequest"; tr "Transfer"; rate "ExchangeRate"; n int; BEGIN
 SELECT * INTO o FROM "FinancialOperation" WHERE "companyId"=c AND id=op;
 SELECT count(*) INTO n FROM "LedgerEntry" WHERE "companyId"=c AND "operationId"=op;
 IF n<2 OR EXISTS(SELECT currency FROM "LedgerEntry" WHERE "companyId"=c AND "operationId"=op GROUP BY currency HAVING sum(CASE WHEN side='DEBIT' THEN amount ELSE -amount END)<>0) THEN RAISE EXCEPTION 'CAISSEPRO_UNBALANCED_OPERATION' USING ERRCODE='23514'; END IF;
 IF o.kind NOT IN ('FX','REVERSAL') AND (o.currency IS NULL OR EXISTS(SELECT FROM "LedgerEntry" WHERE "operationId"=op AND currency<>o.currency)) THEN RAISE EXCEPTION 'CAISSEPRO_CURRENCY_MISMATCH' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT FROM "AuditEvent" WHERE "companyId"=c AND "targetType"='OPERATION' AND "targetId"=op AND "actorId"=o."createdById" AND action='OPERATION_POSTED') THEN RAISE EXCEPTION 'CAISSEPRO_AUDIT_REQUIRED' USING ERRCODE='23514'; END IF;
 IF o.kind='RECEIPT' AND(n<>2 OR NOT EXISTS(SELECT FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" WHERE e."operationId"=op AND e.side='DEBIT' AND a.kind='TREASURY' AND a."agencyId"=o."agencyId") OR NOT EXISTS(SELECT FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" WHERE e."operationId"=op AND e.side='CREDIT' AND a.kind IN ('CLEARING','EQUITY'))) THEN RAISE EXCEPTION 'CAISSEPRO_RECEIPT_INVALID' USING ERRCODE='23514'; END IF;
 IF o.kind='DISBURSEMENT' THEN
  SELECT * INTO ex FROM "ExpenseRequest" WHERE "companyId"=c AND id=o."expenseRequestId";
  IF ex.id IS NULL OR ex.state<>'PAID' OR ex.currency<>o.currency OR ex."agencyId"<>o."agencyId" OR n<>2 OR NOT EXISTS(SELECT FROM "ExpenseApproval" ap WHERE ap."companyId"=c AND ap."expenseRequestId"=ex.id AND ap.decision='APPROVE' AND ap."approverId"<>ex."requestedById" AND ap.amount=ex.amount AND ap.currency=ex.currency) OR NOT EXISTS(SELECT FROM "FundReservation" r WHERE r."companyId"=c AND r."expenseRequestId"=ex.id AND r.state='CONSUMED' AND r.amount=ex.amount) OR NOT EXISTS(SELECT FROM "LedgerEntry" WHERE "operationId"=op AND "accountId"=ex."accountId" AND side='CREDIT' AND amount=ex.amount) OR NOT EXISTS(SELECT FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" WHERE e."operationId"=op AND e.side='DEBIT' AND a.kind IN ('CLEARING','EQUITY')) THEN RAISE EXCEPTION 'CAISSEPRO_UNAPPROVED_EXPENSE' USING ERRCODE='23514'; END IF;
 END IF;
 IF o.kind='TRANSFER' THEN
  SELECT * INTO tr FROM "Transfer" WHERE "companyId"=c AND "operationId"=op;
  IF tr.id IS NULL OR n<>2 OR tr.currency<>o.currency OR NOT EXISTS(SELECT FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" WHERE e."operationId"=op AND e."accountId"=tr."sourceAccountId" AND e.side='CREDIT' AND e.amount=tr.amount AND a.kind='TREASURY' AND a."agencyId"=o."agencyId") OR NOT EXISTS(SELECT FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" WHERE e."operationId"=op AND e."accountId"=tr."destinationAccountId" AND e.side='DEBIT' AND e.amount=tr.amount AND a.kind='TREASURY') THEN RAISE EXCEPTION 'CAISSEPRO_TRANSFER_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 IF o.kind='FX' THEN
  SELECT * INTO rate FROM "ExchangeRate" WHERE "companyId"=c AND id=o."exchangeRateId";
  IF rate.id IS NULL OR rate."effectiveAt">o."postedAt" OR n<>4 OR o."targetAmount"<>caissepro_currency_round(o."sourceAmount"*rate.rate,rate."toCurrency") OR (SELECT count(DISTINCT currency) FROM "LedgerEntry" WHERE "operationId"=op)<>2 OR (SELECT count(*) FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" WHERE e."operationId"=op AND a.kind='TREASURY')<>2 OR NOT EXISTS(SELECT FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" WHERE e."operationId"=op AND a.kind='TREASURY' AND e.side='CREDIT' AND e.currency=rate."fromCurrency" AND e.amount=o."sourceAmount" AND a."agencyId"=o."agencyId") OR NOT EXISTS(SELECT FROM "LedgerEntry" e JOIN "TreasuryAccount" a ON a.id=e."accountId" WHERE e."operationId"=op AND a.kind='TREASURY' AND e.side='DEBIT' AND e.currency=rate."toCurrency" AND e.amount=o."targetAmount") THEN RAISE EXCEPTION 'CAISSEPRO_FX_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 IF o.kind='REVERSAL' AND EXISTS(SELECT "accountId",currency FROM "LedgerEntry" WHERE "companyId"=c AND "operationId" IN(op,o."reversalOfId") GROUP BY "accountId",currency HAVING sum(CASE WHEN side='DEBIT' THEN amount ELSE -amount END)<>0) THEN RAISE EXCEPTION 'CAISSEPRO_REVERSAL_INVALID' USING ERRCODE='23514'; END IF;
END $$;
CREATE OR REPLACE FUNCTION caissepro_expense_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ DECLARE item jsonb; seen text[]:='{}'; k text; BEGIN
 PERFORM caissepro_assert_company_permission(NEW."companyId",nullif(current_setting('caissepro.actor_id',true),'')::uuid,'cash:configure');
 IF NEW."configuredById" IS DISTINCT FROM nullif(current_setting('caissepro.actor_id',true),'')::uuid OR (TG_OP='INSERT' AND NEW.version<>1) THEN RAISE EXCEPTION 'CAISSEPRO_POLICY_INVALID' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW."companyId",NEW.currency) IS DISTINCT FROM ROW(OLD."companyId",OLD.currency) OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'CAISSEPRO_POLICY_CONFLICT' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(NEW.limits) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'CAISSEPRO_POLICY_INVALID' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.limits) LOOP
  k:=(item->>'role')||':'||(item->>'action');
  IF (item->>'role') IS NULL OR (item->>'role') NOT IN('ADMINISTRATOR','DIRECTOR','FINANCE_MANAGER','ACCOUNTANT','CASHIER','AUDITOR') OR (item->>'action') IS NULL OR (item->>'action') NOT IN('REQUEST','APPROVE','PAY') OR (item->>'maximum') IS NULL OR NOT caissepro_money_input_valid(item->>'maximum',NEW.currency) OR (item->>'maximum')::numeric<=0 OR k=ANY(seen) THEN RAISE EXCEPTION 'CAISSEPRO_POLICY_INVALID' USING ERRCODE='23514'; END IF;
  seen:=array_append(seen,k);
 END LOOP;
 NEW."configuredAt":=transaction_timestamp(); RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION caissepro_transfer_order_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('caissepro.actor_id',true),'')::uuid; src "TreasuryAccount"; dst "TreasuryAccount";
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CAISSEPRO_IMMUTABLE_RECORD'; END IF;
 PERFORM caissepro_assert_session(NEW."companyId",actor);
 SELECT * INTO src FROM "TreasuryAccount" WHERE "companyId"=NEW."companyId" AND id=NEW."sourceAccountId";
 SELECT * INTO dst FROM "TreasuryAccount" WHERE "companyId"=NEW."companyId" AND id=NEW."destinationAccountId";
 IF src.id IS NULL OR dst.id IS NULL OR NOT src.active OR NOT dst.active OR src.kind<>'TREASURY' OR dst.kind<>'TREASURY' OR src."cashRegisterId" IS DISTINCT FROM NEW."sourceCashRegisterId" OR dst."cashRegisterId" IS DISTINCT FROM NEW."destinationCashRegisterId" THEN RAISE EXCEPTION 'CAISSEPRO_TRANSFER_INVALID'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'DRAFT' OR NEW.version<>1 OR NEW."authorId"<>actor THEN RAISE EXCEPTION 'CAISSEPRO_TRANSFER_INVALID'; END IF;
  PERFORM caissepro_assert_cash_permission(NEW."companyId",actor,NEW."sourceCashRegisterId",'draft:receive');
  PERFORM caissepro_assert_cash_permission(NEW."companyId",actor,NEW."destinationCashRegisterId",'draft:receive');
  NEW."createdAt":=clock_timestamp();
 ELSE
  IF OLD.state='RECEIVED' OR NEW.version<>OLD.version+1 OR
   (to_jsonb(NEW)-ARRAY['state','version','handedOverAt','receivedAt','handedOverById','receivedById','operationId','slip']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['state','version','handedOverAt','receivedAt','handedOverById','receivedById','operationId','slip']) THEN RAISE EXCEPTION 'CAISSEPRO_TRANSFER_CONFLICT'; END IF;
  PERFORM caissepro_assert_cash_permission(NEW."companyId",actor,NEW."sourceCashRegisterId",'transfer:post');
  PERFORM caissepro_assert_cash_permission(NEW."companyId",actor,NEW."destinationCashRegisterId",'transfer:post');
  IF NEW."sourceCurrency"<>NEW."destinationCurrency" THEN
   PERFORM caissepro_assert_cash_permission(NEW."companyId",actor,NEW."sourceCashRegisterId",'fx:post');
   PERFORM caissepro_assert_cash_permission(NEW."companyId",actor,NEW."destinationCashRegisterId",'fx:post');
  END IF;
  IF OLD.state='DRAFT' AND NEW.state='HANDED_OVER' AND actor=OLD."authorId" AND NEW."handedOverById"=actor THEN
   NEW."handedOverAt":=clock_timestamp();
  ELSIF OLD.state='HANDED_OVER' AND NEW.state='RECEIVED' AND actor<>OLD."handedOverById" AND NEW."receivedById"=actor
   AND ROW(NEW."handedOverAt",NEW."handedOverById") IS NOT DISTINCT FROM ROW(OLD."handedOverAt",OLD."handedOverById") THEN
   NEW."receivedAt":=clock_timestamp();
   SELECT jsonb_build_object('number','TRF-'||c.code||'-'||NEW.id::text,'companyName',c.name,'companyCode',c.code,
    'sourceCashName',sr.name,'destinationCashName',dr.name,'sourceAgencyName',sa.name,'destinationAgencyName',da.name,
    'handedOverByName',hu."displayName",'receivedByName',ru."displayName",'handedOverAt',to_char(NEW."handedOverAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'receivedAt',to_char(NEW."receivedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'rounding','HALF_UP_'||caissepro_currency_precision(NEW."destinationCurrency")::text) INTO NEW.slip
   FROM "Company" c, "CashRegister" sr, "CashRegister" dr, "Agency" sa, "Agency" da, "User" hu, "User" ru
   WHERE c.id=NEW."companyId" AND sr.id=NEW."sourceCashRegisterId" AND dr.id=NEW."destinationCashRegisterId" AND sa.id=src."agencyId" AND da.id=dst."agencyId" AND hu.id=NEW."handedOverById" AND ru.id=actor;
  ELSE RAISE EXCEPTION 'CAISSEPRO_TRANSFER_CONFLICT'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION caissepro_closure_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE s "CashSession"; c "Company"; r "CashRegister"; u "User"; counts jsonb:='[]'::jsonb; f record; counted numeric; BEGIN
 PERFORM caissepro_assert_cash_permission(NEW."companyId",NEW."closedById",NEW."cashRegisterId",'session:manage');
 IF NEW."closedById" IS DISTINCT FROM nullif(current_setting('caissepro.actor_id',true),'')::uuid THEN RAISE EXCEPTION 'CAISSEPRO_ACCESS_DENIED'; END IF;
 SELECT * INTO s FROM "CashSession" WHERE "companyId"=NEW."companyId" AND id=NEW."sessionId" FOR UPDATE;
 IF s.id IS NULL OR s.state<>'CLOSED' OR s."cashRegisterId"<>NEW."cashRegisterId" OR s."closedById"<>NEW."closedById" OR (s."closedAt" IS NULL OR s."closedAt"<transaction_timestamp()) THEN RAISE EXCEPTION 'CAISSEPRO_CLOSURE_INVALID'; END IF;
 FOR f IN SELECT a.currency,b.balance,b.reserved FROM "TreasuryAccount" a JOIN "AvailableFunds" b ON b."accountId"=a.id AND b."companyId"=a."companyId" WHERE a."companyId"=NEW."companyId" AND a."cashRegisterId"=NEW."cashRegisterId" AND a.kind='TREASURY' ORDER BY a.currency LOOP
  IF f.reserved<>0 THEN RAISE EXCEPTION 'CAISSEPRO_CLOSURE_RESERVED_FUNDS'; END IF;
  IF (NEW.snapshot->>f.currency::text) IS NULL OR NOT caissepro_money_input_valid(NEW.snapshot->>f.currency::text,f.currency) THEN RAISE EXCEPTION 'CAISSEPRO_CLOSURE_INVALID'; END IF;
  counted:=(NEW.snapshot->>f.currency::text)::numeric;
  counts:=counts||jsonb_build_array(jsonb_build_object('currency',f.currency,'book',caissepro_money_text(f.balance,f.currency),'counted',caissepro_money_text(counted,f.currency),'difference',caissepro_money_text(counted-f.balance,f.currency)));
 END LOOP;
 IF jsonb_array_length(counts)=0 THEN RAISE EXCEPTION 'CAISSEPRO_CLOSURE_INVALID'; END IF;
 SELECT * INTO c FROM "Company" WHERE id=NEW."companyId"; SELECT * INTO r FROM "CashRegister" WHERE id=NEW."cashRegisterId"; SELECT * INTO u FROM "User" WHERE id=NEW."closedById";
 NEW."closedAt":=s."closedAt";
 NEW.snapshot:=jsonb_build_object('id',NEW.id,'cashRegisterId',r.id,'cashName',r.name,'closedAt',to_char(s."closedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'closedBy',u."displayName",'number','PV-'||c.code||'-'||s.id::text,'counts',counts);
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION caissepro_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."actorId" IS DISTINCT FROM nullif(current_setting('caissepro.actor_id',true),'')::uuid OR NEW.action NOT IN('OPERATION_POSTED','EXPENSE_REQUESTED','EXPENSE_APPROVED','EXPENSE_REJECTED','DRAFT_RECEIVED','CASH_CONFIGURED','AGENCY_CONFIGURED','EXPENSE_POLICY_CONFIGURED','EXPENSE_PAYMENT_CONFIRMED','COMPANY_CONFIGURED','MONETARY_SETTINGS_CONFIGURED','CATEGORY_CONFIGURED','REFERENCE_RATE_PUBLISHED','SESSION_POLICY_CONFIGURED','CASH_SESSION_CLOSED','CASH_SESSION_OPENED','TRANSFER_DRAFT_RECEIVED','TRANSFER_HANDED_OVER','TRANSFER_RECEIVED') OR NEW."targetType" NOT IN('OPERATION','EXPENSE','DRAFT','CASH','AGENCY','COMPANY','CATEGORY','RATE','CLOSURE','TRANSFER') THEN RAISE EXCEPTION 'CAISSEPRO_AUDIT_INVALID' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION caissepro_assert_expense_limit(uuid,uuid,"Currency",text,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION caissepro_assert_expense_limit(uuid,uuid,"Currency",text,numeric) TO caissepro_runtime;
COMMIT;

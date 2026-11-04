import { draftSchema,draftSyncResultSchema,type Draft,type DraftSyncResult } from '@caissepro/shared';
export const MAX_OFFLINE_TTL=15*60*1000;
export type LocalRecord={draft:Draft;version:number;state:'local'|'synced'|'conflict'|'error';updatedAt:string;synchronizedAt:string|null;serverVersion:number|null;result:DraftSyncResult|null};
export type AuthorizedCache={id:string;version:number;schemaVersion:1;synchronizedAt:string;expiresAt:string;data:unknown};
export type CacheGrant={scope:string;resourceId:string;permission:string;authorizedUntil:number};
export interface LocalStore {readonly persistence:'memory-only';readonly generation:number;saveDraft(draft:Draft,expectedVersion?:number):LocalRecord;listDrafts():LocalRecord[];recordSyncResult(id:string,version:number,result:unknown):boolean;clear():void;}
export class MemoryLocalStore implements LocalStore {
 readonly persistence='memory-only' as const;private scope:string|null=null;private revision=0;private drafts=new Map<string,LocalRecord>();private caches=new Map<string,{snapshot:AuthorizedCache;grant:CacheGrant}>();
 get generation(){return this.revision;}
 activateScope(scope:string){if(!scope.trim())throw new Error('SCOPE_REQUIRED');this.clear();this.scope=scope;}
 clear(){this.scope=null;this.drafts.clear();this.caches.clear();this.revision++;}
 private requireScope(){if(!this.scope)throw new Error('AUTHORIZED_SCOPE_REQUIRED');}
 private prune(){const now=Date.now();for(const [id,r] of this.drafts)if(Date.parse(r.draft.expiresAt)<=now)this.drafts.delete(id);for(const [id,r]of this.caches)if(Date.parse(r.snapshot.expiresAt)<=now||r.grant.authorizedUntil<=now)this.caches.delete(id);}
 saveDraft(value:Draft,expectedVersion?:number){
  this.requireScope();this.prune();const draft=draftSchema.parse(value);const now=Date.now();
  if(Date.parse(draft.expiresAt)<=now||Date.parse(draft.createdAt)>now+1000||Date.parse(draft.expiresAt)-Date.parse(draft.createdAt)>MAX_OFFLINE_TTL)throw new Error('OFFLINE_EXPIRATION_INVALID');
  const previous=this.drafts.get(draft.id);
  if(previous && JSON.stringify(previous.draft)===JSON.stringify(draft))return structuredClone(previous);
  if(previous&&(expectedVersion!==previous.version||draft.kind!==previous.draft.kind||draft.createdAt!==previous.draft.createdAt||draft.expiresAt!==previous.draft.expiresAt))throw new Error('LOCAL_VERSION_CONFLICT');
  if(!previous&&expectedVersion!==undefined)throw new Error('LOCAL_VERSION_CONFLICT');
  const record:LocalRecord={draft,version:(previous?.version??0)+1,state:'local',updatedAt:new Date(now).toISOString(),synchronizedAt:previous?.synchronizedAt??null,serverVersion:previous?.serverVersion??null,result:null};
  this.drafts.set(draft.id,record);return structuredClone(record);
 }
 listDrafts(){this.requireScope();this.prune();return structuredClone([...this.drafts.values()]);}
 recordSyncResult(id:string,version:number,value:unknown){this.requireScope();this.prune();const result=draftSyncResultSchema.parse(value);const record=this.drafts.get(id);if(!record||record.version!==version||result.draftId!==id)return false;record.result=result;record.state=result.outcome==='accepted-as-draft'?'synced':result.outcome==='conflict'?'conflict':result.outcome==='rejected'?'error':'local';if(result.outcome==='accepted-as-draft'){record.serverVersion=version;record.synchronizedAt=new Date().toISOString();}return true;}
 cacheAuthorized(snapshot:AuthorizedCache,grant:CacheGrant){
  this.requireScope();this.prune();const now=Date.now(),sync=Date.parse(snapshot.synchronizedAt),expiry=Date.parse(snapshot.expiresAt);
  if(grant.scope!==this.scope||grant.resourceId!==snapshot.id||!grant.permission.trim()||grant.authorizedUntil<=now||snapshot.schemaVersion!==1||!Number.isSafeInteger(snapshot.version)||snapshot.version<1||!Number.isFinite(sync)||!Number.isFinite(expiry)||sync>now+1000||expiry<=now||expiry-sync>MAX_OFFLINE_TTL||expiry>grant.authorizedUntil)throw new Error('OFFLINE_ACCESS_DENIED');
  const previous=this.caches.get(snapshot.id);if(previous&&previous.snapshot.version>=snapshot.version)throw new Error('LOCAL_VERSION_CONFLICT');
  this.caches.set(snapshot.id,structuredClone({snapshot,grant}));
 }
 readCache(id:string,permission:string){this.requireScope();this.prune();const record=this.caches.get(id);return record&&record.grant.permission===permission?{...structuredClone(record.snapshot),stale:true as const}:null;}
}
export function createLocalDraft(input:Pick<Draft,'kind'|'currency'|'amount'|'description'>):Draft{const now=Date.now();return draftSchema.parse({...input,id:crypto.randomUUID(),createdAt:new Date(now).toISOString(),expiresAt:new Date(now+MAX_OFFLINE_TTL).toISOString()});}
export function assertDiskPersistenceAllowed():never{throw new Error('PLATFORM_ENCRYPTION_NOT_VALIDATED');}

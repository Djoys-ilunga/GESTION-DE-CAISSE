export const READINESS_DATABASE=Symbol('READINESS_DATABASE');
export interface ReadinessDatabase {installation:{count():Promise<number>}}

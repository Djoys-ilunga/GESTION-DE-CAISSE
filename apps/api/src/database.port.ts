export const READINESS_DATABASE = Symbol('READINESS_DATABASE');
export interface ReadinessDatabase {
  ready(): Promise<number>;
}

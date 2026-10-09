import type { Profile } from '../shared/types.js'
import { createSqliteJsonStore } from './module-state-store.js'

export const profileRepository = createSqliteJsonStore<{ profiles: Profile[]; version: number }>({
  tableName: 'profiles',
  defaults: { profiles: [], version: 1 },
})

export function readProfile(id: string): Profile | null {
  return (profileRepository.get('profiles') as Profile[]).find(profile => profile.id === id) ?? null
}

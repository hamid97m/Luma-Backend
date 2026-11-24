import { isSafeObjectPath } from '../storage.js'

/** `.../profile-photos/<userId>/<photoId>` (any host: migrated files kept
 *  their paths) → the object path on local disk; null for anything else. */
export function profilePhotoObjectPath(url: string): string | null {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(url).pathname)
  } catch {
    return null
  }
  const marker = '/profile-photos/'
  const at = pathname.indexOf(marker)
  if (at < 0) return null
  const objectPath = pathname.slice(at + marker.length)
  return isSafeObjectPath(objectPath) ? objectPath : null
}

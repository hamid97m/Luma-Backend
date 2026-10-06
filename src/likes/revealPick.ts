const TEHRAN_OFFSET_MS = (3 * 60 + 30) * 60 * 1000

export function tehranDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

export function msUntilNextTehranHour(hour: number, now: Date): number {
  const tehranNow = new Date(now.getTime() + TEHRAN_OFFSET_MS)
  const target = new Date(tehranNow)
  target.setUTCHours(hour, 0, 0, 0)
  if (target.getTime() <= tehranNow.getTime()) target.setUTCDate(target.getUTCDate() + 1)
  return target.getTime() - tehranNow.getTime()
}

export interface RevealViewer {
  geoCity: string | null
}

export interface RevealCandidate {
  id: string
  geoCity: string | null
  lastActive: string
  likedAt: string
}

export function pickRevealCandidate(viewer: RevealViewer, candidates: RevealCandidate[]): RevealCandidate | null {
  if (candidates.length === 0) return null
  const sameCity = viewer.geoCity
    ? candidates.filter((c) => c.geoCity === viewer.geoCity)
    : []
  const pool = sameCity.length > 0 ? sameCity : candidates
  return [...pool].sort((a, b) => {
    const active = b.lastActive.localeCompare(a.lastActive)
    if (active !== 0) return active
    return a.likedAt.localeCompare(b.likedAt)
  })[0]
}

export function isEligibleRevealLiker(liker: {
  isSeed: boolean
  pausedAt: string | null
  deletedAt: string | null
  bannedAt: string | null
  photoCount: number
}): boolean {
  return !liker.isSeed && !liker.pausedAt && !liker.deletedAt && !liker.bannedAt && liker.photoCount > 0
}

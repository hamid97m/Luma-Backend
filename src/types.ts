export interface DBUser {
  id: string
  telegram_id: number
  username: string | null
  name: string
  age: number
  gender: 'man' | 'woman' | 'nonbinary'
  looking_for: 'men' | 'women' | 'both' | 'everyone'
  bio: string | null
  interests: string[]
  location: string | null
  icebreaker_prompt: string | null
  icebreaker_answer: string | null
  is_active: boolean
  deleted_at: string | null
  created_at: string
  last_active: string
  allows_write_to_pm: boolean | null
}

export interface DBPhoto {
  id: string
  user_id: string
  url: string
  position: number
  created_at: string
}

export interface TelegramUser {
  id: number
  first_name: string
  last_name?: string
  username?: string
  allows_write_to_pm?: boolean
}

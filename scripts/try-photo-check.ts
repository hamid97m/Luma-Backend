import 'dotenv/config'
import { askDeepSeekPhoto } from '../src/moderation/photoAiCheck.js'

// Sends image URLs through the live main-photo AI check and prints each
// verdict. Read-only: nothing is stored and nobody is paused. Run it with the
// production key before enabling the check, to confirm DeepSeek sees images.
//   pnpm -C backend try:photo-check [imageUrl ...]

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY is not set')
  process.exit(1)
}

const SAMPLES = [
  'https://randomuser.me/api/portraits/men/32.jpg', // ordinary headshot: expect approved
  'https://upload.wikimedia.org/wikipedia/commons/8/8d/President_Barack_Obama.jpg', // expect celebrity_or_stock
  'https://upload.wikimedia.org/wikipedia/en/0/02/Homer_Simpson_2006.png', // expect not_real_person
]

const urls = process.argv.slice(2)
for (const [i, url] of (urls.length ? urls : SAMPLES).entries()) {
  try {
    console.log(url, '=>', await askDeepSeekPhoto(`try-${i}`, url))
  } catch (err) {
    console.log(url, '=> failed:', (err as Error).message)
  }
}

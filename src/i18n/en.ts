import type { Messages } from './index.js'

// English strings for everything the backend shows to end users.
// Mirrors fa.ts key-for-key; the shape test enforces it.
export const en = {
  bot: {
    openAppButton: 'Open Luma ❤️',
    replyButton: 'Reply',
    start:
      'Come on in → your matches are waiting 💫 You can pause or delete your account any time.',
    description: [
      'Welcome to Luma 💜',
      '',
      'Luma is where you meet real people right inside Telegram — no separate app, no phone number.',
      '',
      'Build your profile, swipe, match and start talking. You can pause or delete your account whenever you like.',
      '',
      'Ready? Tap the button below to get started ✨',
    ].join('\n'),
  },
  support: {
    prompt: "What's the problem? Send it to me in one message and I'll open a support ticket for you.",
    ticketSaved: 'Thanks — your ticket is saved. We reply here and inside the app.',
    tooManyOpen:
      'You have several open tickets — please wait for a reply before opening a new one.',
    saveFailed: "Sorry, that didn't save. Please try /support again.",
    ticketReply: (preview: string, answer: string) =>
      `📮 Support reply\n\nYour issue:\n“${preview}”\n\nOur answer:\n${answer}`,
  },
  notify: {
    match: (name: string) => `${name} liked you back! Open Luma ❤️`,
    newLike: (name: string) => `${name} liked you 💛 — open Luma to see`,
    newMessage: (name: string, body: string) => `New message from ${name}\n${body}`,
    giftIntro: (name: string, emoji: string) =>
      `${name} sent you a gift ${emoji} — open Luma to see who!`,
    paused: 'Your profile is temporarily hidden. Upload a fresh photo of yourself in Luma to come back ✨',
    fakePhotoWarningWoman:
      'Your profile photo was reported as fake. You are beautiful, and there is no need for someone else\'s photo. People you know will not see you here. Upload a real photo of yourself.',
    fakePhotoWarningMan:
      'Your profile photo was reported as fake. Replace it with a real photo of yourself, or we will block your account.',
    fallbackName: 'Someone',
  },
  referral: {
    qualified: (name: string) => `${name} joined Luma with your invite link 🎉 Thanks for spreading the word!`,
    rewardSwipes: (n: number) => `Referral reward: you got ${n} extra discovery swipes! 🔥`,
    rewardPremium: (days: number) => `Referral reward: you got ${days} days of Premium! 🌟`,
  },
  gifts: {
    invoiceTitle: (emoji: string) => `Gift ${emoji}`,
    invoiceDescription: 'Send a gift',
    sentYouGift: (emoji: string) => `sent you a gift ${emoji}`,
    checkoutUnavailable: 'This gift is no longer available.',
    checkoutAlreadyProcessed: 'This gift has already been processed.',
    checkoutPriceMismatch: "The price doesn't match.",
    checkoutSoldOut: 'This gift just sold out.',
  },
  premium: {
    invoiceDescriptionFallback: (days: number) => `${days}-day Premium subscription`,
    checkoutUnavailable: 'This purchase is no longer available.',
    checkoutAlreadyProcessed: 'This purchase has already been processed.',
    checkoutPriceMismatch: "The price doesn't match.",
    purchased: (days: number) =>
      `Congrats! 🌟 Your ${days}-day Premium is active.\nNow you can see who liked you and chat without limits. Open Luma ✨`,
  },
  chat: {
    seedGreeting: 'Hi',
  },
} satisfies Messages

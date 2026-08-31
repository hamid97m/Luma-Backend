// Persian (fa) strings for everything the backend shows to end users:
// Telegram bot messages, notifications, Stars invoices and pre-checkout errors.
// To add another language later, copy this file and switch the export in i18n/index.ts.

export const fa = {
  bot: {
    openAppButton: 'باز کردن لوما ❤️',
    start:
      'بیا داخل اپ → مچ‌ها منتظرتن 💫 هر وقت بخواهی می‌توانی حسابت را متوقف یا حذف کنی.',
    description: [
      'به لوما خوش اومدی 💜',
      '',
      'لوما جاییه که آدم‌های واقعی رو همین داخل تلگرام پیدا می‌کنی — بدون نصب اپ جدا، بدون شماره تلفن.',
      '',
      'پروفایلت رو بساز، سوایپ کن، مچ شو و گفتگو رو شروع کن. هر وقت هم بخوای، می‌تونی حسابت رو متوقف یا حذف کنی.',
      '',
      'آماده‌ای؟ دکمهٔ پایین رو بزن و شروع کن ✨',
    ].join('\n'),
  },
  support: {
    prompt: 'مشکلت چیه؟ در یک پیام برایم بفرست تا برایت تیکت پشتیبانی باز کنم.',
    ticketSaved: 'ممنون — تیکتت ثبت شد. همین‌جا و داخل اپ جواب می‌دهیم.',
    tooManyOpen:
      'چند تیکت باز داری — لطفاً قبل از باز کردن تیکت جدید، منتظر پاسخ بمان.',
    saveFailed: 'ببخشید، ذخیره نشد. لطفاً دوباره /support را امتحان کن.',
    ticketReply: (preview: string, answer: string) =>
      `📮 پاسخ پشتیبانی\n\nمشکل تو:\n«${preview}»\n\nپاسخ ما:\n${answer}`,
  },
  notify: {
    match: (name: string) => `${name} لایکت کرد! لوما را باز کن ❤️`,
    newLike: (name: string) => `${name} لایکت کرد 💛 — برای دیدن، لوما را باز کن`,
    newMessage: (name: string, body: string) => `پیام جدید از ${name}\n${body}`,
    giftIntro: (name: string, emoji: string) =>
      `${name} برایت هدیه فرستاده ${emoji} — لوما را باز کن و ببین کی!`,
    paused: 'پروفایلت موقتاً از نمایش خارج شد. برای بازگشت، یک عکس تازه از خودت در لوما بارگذاری کن ✨',
    fallbackName: 'یک نفر',
  },
  gifts: {
    invoiceTitle: (emoji: string) => `هدیه ${emoji}`,
    invoiceDescription: 'ارسال هدیه',
    sentYouGift: (emoji: string) => `برایت هدیه فرستاد ${emoji}`,
    checkoutUnavailable: 'این هدیه دیگر موجود نیست.',
    checkoutAlreadyProcessed: 'این هدیه قبلاً پردازش شده است.',
    checkoutPriceMismatch: 'قیمت همخوانی ندارد.',
    checkoutSoldOut: 'این هدیه همین الان تمام شد.',
  },
  premium: {
    invoiceDescriptionFallback: (days: number) => `اشتراک پرمیوم ${days} روزه`,
    checkoutUnavailable: 'این خرید دیگر در دسترس نیست.',
    checkoutAlreadyProcessed: 'این خرید قبلاً پردازش شده است.',
    checkoutPriceMismatch: 'قیمت همخوانی ندارد.',
  },
  chat: {
    seedGreeting: 'سلام',
  },
} as const;

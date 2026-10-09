import type { Messages } from './index.js'

// Arabic (Modern Standard, informal register) strings for everything the
// backend shows to end users. Mirrors fa.ts key-for-key.
export const ar = {
  bot: {
    openAppButton: 'افتح لوما ❤️',
    replyButton: 'رد',
    start:
      'تفضّل بالدخول → مطابقاتك في انتظارك 💫 يمكنك إيقاف حسابك مؤقتًا أو حذفه في أي وقت.',
    description: [
      'أهلًا بك في لوما 💜',
      '',
      'لوما هو المكان الذي تلتقي فيه بأشخاص حقيقيين داخل تيليجرام مباشرة — بدون تطبيق منفصل وبدون رقم هاتف.',
      '',
      'أنشئ ملفك، اسحب، طابق وابدأ المحادثة. ويمكنك إيقاف حسابك مؤقتًا أو حذفه متى شئت.',
      '',
      'جاهز؟ اضغط الزر بالأسفل وابدأ ✨',
    ].join('\n'),
  },
  support: {
    prompt: 'ما المشكلة؟ أرسلها لي في رسالة واحدة وسأفتح لك تذكرة دعم.',
    ticketSaved: 'شكرًا — تم حفظ تذكرتك. سنرد هنا وداخل التطبيق.',
    tooManyOpen:
      'لديك عدة تذاكر مفتوحة — يرجى انتظار الرد قبل فتح تذكرة جديدة.',
    saveFailed: 'عذرًا، لم يتم الحفظ. يرجى تجربة /support مرة أخرى.',
    ticketReply: (preview: string, answer: string) =>
      `📮 رد الدعم\n\nمشكلتك:\n«${preview}»\n\nردّنا:\n${answer}`,
  },
  notify: {
    match: (name: string) => `${name} أعجب بك أيضًا! افتح لوما ❤️`,
    matchWithQuestion: (name: string, question: string) =>
      `${name} أعجب بك أيضًا ويسألك:\n«${question}»\nافتح لوما وأجب ❤️`,
    newLike: (name: string) => `${name} أعجب بك 💛 — افتح لوما لترى`,
    newMessage: (name: string, body: string) => `رسالة جديدة من ${name}\n${body}`,
    giftIntro: (name: string, emoji: string) =>
      `${name} أرسل لك هدية ${emoji} — افتح لوما لترى من!`,
    paused: 'تم إخفاء ملفك مؤقتًا. لتعود، ارفع صورة جديدة لنفسك في لوما ✨',
    fakePhotoWarningWoman:
      'أُبلغ عن صورة ملفك على أنها ليست لكِ. أنتِ جميلة، ولا حاجة لصورة شخص آخر. من تعرفينهم لن يروكِ هنا. ضعي صورة حقيقية لكِ.',
    fakePhotoWarningMan:
      'أُبلغ عن صورة ملفك على أنها مزيفة. استبدلها بصورة حقيقية لك، وإلا سنحظر حسابك.',
    fallbackName: 'شخص ما',
  },
  referral: {
    qualified: (name: string) => `${name} انضم إلى لوما عبر رابط دعوتك 🎉 شكرًا لأنك تعرّف الناس على لوما!`,
    rewardSwipes: (n: number) => `مكافأة الدعوة: حصلت على ${n} سحبة اكتشاف إضافية! 🔥`,
    rewardPremium: (days: number) => `مكافأة الدعوة: حصلت على ${days} يومًا من بريميوم! 🌟`,
  },
  gifts: {
    invoiceTitle: (emoji: string) => `هدية ${emoji}`,
    invoiceDescription: 'إرسال هدية',
    sentYouGift: (emoji: string) => `أرسل لك هدية ${emoji}`,
    checkoutUnavailable: 'هذه الهدية لم تعد متاحة.',
    checkoutAlreadyProcessed: 'تمت معالجة هذه الهدية مسبقًا.',
    checkoutPriceMismatch: 'السعر غير متطابق.',
    checkoutSoldOut: 'نفدت هذه الهدية للتو.',
  },
  premium: {
    invoiceDescriptionFallback: (days: number) => `اشتراك بريميوم لمدة ${days} يومًا`,
    checkoutUnavailable: 'هذا الشراء لم يعد متاحًا.',
    checkoutAlreadyProcessed: 'تمت معالجة هذا الشراء مسبقًا.',
    checkoutPriceMismatch: 'السعر غير متطابق.',
    purchased: (days: number) =>
      `مبروك! 🌟 تم تفعيل اشتراك بريميوم لمدة ${days} يومًا.\nالآن يمكنك رؤية من أعجب بك والدردشة بلا حدود. افتح لوما ✨`,
  },
  chat: {
    seedGreeting: 'مرحبًا',
  },
  icebreaker: {
    questions: [
      'كيف يبدو يوم الجمعة المثالي بالنسبة لك؟',
      'هل تستطيع تخمين أيّها الكذبة؟',
      'وما الطريق إلى قلبك أنت؟',
      'ما الشيء الذي تعشقه بجنون؟',
      'ما هو الموعد الأول المثالي في رأيك؟',
      'هل توافق أم تعارض؟',
      'هل تظن أننا سننسجم؟',
      'وأنت — صباح هادئ أم جدول مزدحم؟',
      'ما هي مهارتك الغريبة؟',
      'هل ستأتي معي؟',
      'ما آخر شيء أضحكك؟',
      'ما العلامات الإيجابية التي تبحث عنها؟',
    ],
    fallbackQuestion: 'وأنت؟',
  },
} satisfies Messages

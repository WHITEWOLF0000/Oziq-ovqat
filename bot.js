require('dotenv').config();
const { Bot, InlineKeyboard, Keyboard, session } = require("grammy");
const Database = require('better-sqlite3');

const db = new Database('avigo.db');
const bot = new Bot(process.env.BOT_TOKEN);

bot.use(session({
    initial: () => ({ step: "IDLE" })
}));

const i18n = {
    uz: {
        welcome: "Xush kelibsiz! Ism-familiyangizni kiriting:",
        ask_phone: "Telefon raqamingizni yuboring:",
        order: "🍟 Buyurtma berish",
        settings: "⚙️ Sozlamalar",
        feedback: "📩 Takliflar",
        done: "✅ Ma'lumotlar saqlandi!",
        current_data: "📝 Sizning ma'lumotlaringiz:\n\n👤 Ism: {name}\n📞 Tel: {phone}\n🌐 Til: {lang}",
        edit_name: "Ismni o'zgartirish",
        edit_phone: "Nomerni o'zgartirish",
        edit_lang: "Tilni o'zgartirish",
        feedback_prompt: "Xabaringizni yozing:"
    },
    ru: {
        welcome: "Добро пожаловать! Введите имя и фамилию:",
        ask_phone: "Отправьте ваш номер телефона:",
        order: "🍟 Заказать",
        settings: "⚙️ Настройки",
        feedback: "📩 Жалобы",
        done: "✅ Данные сохранены!",
        current_data: "📝 Ваши данные:\n\n👤 Имя: {name}\n📞 Тел: {phone}\n🌐 Язык: {lang}",
        edit_name: "Изменить имя",
        edit_phone: "Изменить номер",
        edit_lang: "Изменить язык",
        feedback_prompt: "Напишите ваше сообщение:"
    }
};

const getMainMenu = (lang) => {
    return new Keyboard()
        .text(i18n[lang].order).row()
        .text(i18n[lang].feedback).text(i18n[lang].settings)
        .resized();
};

// 1. СТАРТ
bot.command("start", async (ctx) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.from.id);
    if (user && user.fullName && user.phone) {
        await ctx.reply(`Xush kelibsiz, ${user.fullName}!`, { reply_markup: getMainMenu(user.lang || 'uz') });
    } else {
        ctx.session.step = "CHOOSE_LANG";
        await ctx.reply("Tilni tanlang / Выберите язык:", {
            reply_markup: new InlineKeyboard().text("O'zbekcha 🇺🇿", "lang_uz").text("Русский 🇷🇺", "lang_ru")
        });
    }
});

// 2. ОБРАБОТКА НАСТРОЕК (Показ данных)
async function showSettings(ctx, user) {
    const lang = user.lang || "uz";
    const langName = lang === 'uz' ? "O'zbekcha 🇺🇿" : "Русский 🇷🇺";
    
    // Заменяем плейсхолдеры на реальные данные
    let text = i18n[lang].current_data
        .replace('{name}', user.fullName || '—')
        .replace('{phone}', user.phone || '—')
        .replace('{lang}', langName);

    const keyboard = new InlineKeyboard()
        .text("👤 " + i18n[lang].edit_name, "edit_name").row()
        .text("📞 " + i18n[lang].edit_phone, "edit_phone").row()
        .text("🌐 " + i18n[lang].edit_lang, "edit_lang");

    await ctx.reply(text, { reply_markup: keyboard });
}

// 3. CALLBACKS
bot.callbackQuery(/^lang_/, async (ctx) => {
    const lang = ctx.callbackQuery.data.split("_")[1];
    db.prepare('INSERT OR IGNORE INTO users (id, lang) VALUES (?, ?)').run(ctx.from.id, lang);
    db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, ctx.from.id);
    await ctx.answerCallbackQuery();
    
    if (ctx.session.step === "CHOOSE_LANG") {
        ctx.session.step = "ASK_NAME";
        await ctx.editMessageText(i18n[lang].welcome);
    } else {
        ctx.session.step = "IDLE";
        await ctx.reply(i18n[lang].done, { reply_markup: getMainMenu(lang) });
    }
});

bot.callbackQuery("edit_name", async (ctx) => {
    const user = db.prepare('SELECT lang FROM users WHERE id = ?').get(ctx.from.id);
    ctx.session.step = "ASK_NAME";
    await ctx.answerCallbackQuery();
    await ctx.reply(i18n[user.lang].welcome, { reply_markup: { remove_keyboard: true } });
});

bot.callbackQuery("edit_phone", async (ctx) => {
    const user = db.prepare('SELECT lang FROM users WHERE id = ?').get(ctx.from.id);
    ctx.session.step = "ASK_PHONE";
    await ctx.answerCallbackQuery();
    await ctx.reply(i18n[user.lang].ask_phone, {
        reply_markup: new Keyboard().requestContact("📱 Telefon yuborish").resized().oneTime()
    });
});

bot.callbackQuery("edit_lang", async (ctx) => {
    ctx.session.step = "EDIT_LANG";
    await ctx.answerCallbackQuery();
    await ctx.reply("Tilni tanlang / Выберите язык:", {
        reply_markup: new InlineKeyboard().text("O'zbekcha 🇺🇿", "lang_uz").text("Русский 🇷🇺", "lang_ru")
    });
});

// 4. ТЕКСТОВЫЕ СООБЩЕНИЯ
bot.on("message:text", async (ctx) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.from.id);
    const lang = user?.lang || "uz";

    if (ctx.session.step === "ASK_NAME") {
        db.prepare('UPDATE users SET fullName = ? WHERE id = ?').run(ctx.message.text, ctx.from.id);
        if (!user?.phone) {
            ctx.session.step = "ASK_PHONE";
            await ctx.reply(i18n[lang].ask_phone, {
                reply_markup: new Keyboard().requestContact("📱 Telefon yuborish").resized().oneTime()
            });
        } else {
            ctx.session.step = "IDLE";
            await ctx.reply(i18n[lang].done, { reply_markup: getMainMenu(lang) });
        }
    } 
    else if (ctx.session.step === "WAITING_FEEDBACK") {
        await bot.api.sendMessage(process.env.ADMIN_ID, `📩 TAKLIF:\n👤 ${user.fullName}\n📞 ${user.phone}\n📝 ${ctx.message.text}`);
        ctx.session.step = "IDLE";
        await ctx.reply(i18n[lang].done, { reply_markup: getMainMenu(lang) });
    }
    else {
        switch (ctx.message.text) {
            case i18n[lang].order:
                await ctx.reply("Menyuni oching:", {
                    reply_markup: new InlineKeyboard().webApp("🍟 Menyu", `${process.env.WEB_APP_URL}?userId=${ctx.from.id}`)
                });
                break;
            case i18n[lang].settings:
                await showSettings(ctx, user); // Вызываем функцию показа данных
                break;
            case i18n[lang].feedback:
                ctx.session.step = "WAITING_FEEDBACK";
                await ctx.reply(i18n[lang].feedback_prompt, { reply_markup: { remove_keyboard: true } });
                break;
        }
    }
});

bot.on("message:contact", async (ctx) => {
    const user = db.prepare('SELECT lang FROM users WHERE id = ?').get(ctx.from.id);
    db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(ctx.message.contact.phone_number, ctx.from.id);
    ctx.session.step = "IDLE";
    await ctx.reply(i18n[user.lang].done, { reply_markup: getMainMenu(user.lang) });
});

// 5. ОПЛАТА
bot.on("message:web_app_data", async (ctx) => {
    const data = JSON.parse(ctx.message.web_app_data.data);
    if (data.action === "payment_request") {
        await ctx.replyWithInvoice(
            "Buyurtma to'lovi", data.items, `pay_${ctx.from.id}`,
            process.env.PAYMENT_TOKEN, "UZS", [{ label: "Jami", amount: data.total_price * 100 }]
        );
    }
});

bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true));

bot.start();
require('dotenv').config();
const { Bot, InlineKeyboard, Keyboard, session } = require("grammy");
const Database = require('better-sqlite3');
const express = require('express');

const db = new Database('avigo.db');
const bot = new Bot(process.env.BOT_TOKEN);
const app = express();

app.use(express.json());

// Ma'lumotlar bazasini tekshirish/yaratish
db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        fullName TEXT,
        phone TEXT,
        lang TEXT DEFAULT 'uz'
    )
`).run();

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
        feedback_prompt: "Xabaringizni yozing:",
        payment_title: "Buyurtma to'lovi",
        payment_success: "✅ To'lov muvaffaqiyatli amalga oshirildi! Buyurtmangiz tayyorlanmoqda."
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
        feedback_prompt: "Напишите ваше сообщение:",
        payment_title: "Оплата заказа",
        payment_success: "✅ Оплата прошла успешно! Ваш заказ готовится."
    }
};

const getMainMenu = (lang) => {
    return new Keyboard()
        .text(i18n[lang].order).row()
        .text(i18n[lang].feedback).text(i18n[lang].settings)
        .resized();
};

async function showSettings(ctx, user) {
    const lang = user.lang || "uz";
    const langName = lang === 'uz' ? "O'zbekcha 🇺🇿" : "Русский 🇷🇺";
    
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

// 1. START
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

// 2. CALLBACKS
bot.callbackQuery(/^lang_/, async (ctx) => {
    const lang = ctx.callbackQuery.data.split("_")[1];
    db.prepare('INSERT OR IGNORE INTO users (id, lang) VALUES (?, ?)').run(ctx.from.id, lang);
    db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, ctx.from.id);
    await ctx.answerCallbackQuery();
    
    if (ctx.session.step === "CHOOSE_LANG" || ctx.session.step === "EDIT_LANG") {
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

// 3. MINI APP MA'LUMOTI (IKKI XIL TO'LOV USULI BILAN)
bot.on("message:web_app_data", async (ctx) => {
    try {
        const data = JSON.parse(ctx.message.web_app_data.data);
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.from.id);
        const lang = user?.lang || 'uz';

        if (data.action === "new_order") {
            const methodText = data.method === 'click' ? "💳 Click" : "💵 Naqd (Kuryerga)";
            
            // --- ADMINGA XABAR YUBORISH ---
            const orderText = `🛍 **YANGI BUYURTMA!**\n\n` +
                              `👤 Mijoz: ${user?.fullName || ctx.from.first_name}\n` +
                              `📞 Tel: ${user?.phone || "Noma'lum"}\n` +
                              `📦 Mahsulotlar: ${data.items}\n` +
                              `💰 Jami: ${data.total_price.toLocaleString()} so'm\n` +
                              `🏦 To'lov turi: ${methodText}`;

            await bot.api.sendMessage(process.env.ADMIN_ID, orderText, { parse_mode: "Markdown" });

            // --- FOYDALANUVCHIGA JAVOB ---
            if (data.method === 'click') {
                const amount = data.total_price;
                const transactionParam = `order_${ctx.from.id}_${Date.now()}`;
                const paymentUrl = `https://my.click.uz/pay/?service_id=${process.env.CLICK_SERVICE_ID}&merchant_id=${process.env.CLICK_MERCHANT_ID}&amount=${amount}&transaction_param=${transactionParam}`;

                await ctx.reply(`✅ Buyurtma qabul qilindi. To'lov turi: Click.\n\nTo'lov qilish uchun quyidagi tugmani bosing:`, {
                    reply_markup: new InlineKeyboard().url("To'lash (Click)", paymentUrl)
                });
            } else {
                const cashMsg = lang === 'uz' 
                    ? `✅ Buyurtmangiz qabul qilindi!\n💰 To'lov turi: Naqd (kuryerga).\n📦 Tez orada kuryerimiz bog'lanadi.` 
                    : `✅ Ваш заказ принят!\n💰 Способ оплаты: Наличными.\n📦 Скоро наш курьер свяжется с вами.`;
                
                await ctx.reply(cashMsg, { reply_markup: getMainMenu(lang) });
            }
        }
    } catch (e) {
        console.error("WebAppData error:", e);
        await ctx.reply("Xatolik yuz berdi.");
    }
});

// 4. TEXT MESSAGES
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
                    reply_markup: new Keyboard()
                        .webApp("🍟 Menyu", `${process.env.WEB_APP_URL}`)
                        .resized()
                        .oneTime()
                });
                break;
            case i18n[lang].settings:
                await showSettings(ctx, user);
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

app.post('/payment/callback', (req, res) => {
    try {
        const { click_trans_id, merchant_trans_id, status } = req.body;
        if (status == 1) {
            const parts = merchant_trans_id.split('_');
            if (parts[0] === 'order') {
                const userId = parts[1];
                bot.api.sendMessage(userId, '✅ To\'lov muvaffaqiyatli amalga oshirildi! Buyurtmangiz tayyorlanmoqda.');
            }
        }
        res.send('OK');
    } catch (e) {
        res.status(500).send('Error');
    }
});

(async () => {
    bot.start().catch(err => console.error("Bot start error:", err));
    app.listen(process.env.PORT || 3000, () => {
        console.log('Server running on port', process.env.PORT || 3000);
    });
})();
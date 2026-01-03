require('dotenv').config();
const { Bot, InlineKeyboard, Keyboard, session } = require("grammy");
const Database = require('better-sqlite3');
const express = require('express');

const db = new Database('avigo.db');
const bot = new Bot(process.env.BOT_TOKEN);
const app = express();

app.use(express.json());

db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        fullName TEXT,
        phone TEXT,
        lang TEXT DEFAULT 'uz'
    )
`).run();

// Sessiyani to'g'ri sozlash
bot.use(session({
    initial: () => ({ step: "IDLE", tempOrder: null })
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
        payment_description: "Tanlangan mahsulotlar: {items}",
        payment_success: "✅ To'lov muvaffaqiyatli amalga oshirildi!"
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
        payment_description: "Выбранные товары: {items}",
        payment_success: "✅ Оплата прошла успешно!"
    }
};

const getMainMenu = (lang) => {
    return new Keyboard()
        .text(i18n[lang].order).row()
        .text(i18n[lang].feedback).text(i18n[lang].settings)
        .resized();
};

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

// TO'LOV CALLBACK (PROVIDER_TOKEN ishlatilgan)
bot.callbackQuery(/^pay_/, async (ctx) => {
    const action = ctx.callbackQuery.data;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.from.id);
    const lang = user?.lang || 'uz';
    const order = ctx.session.tempOrder;

    if (!order) return ctx.answerCallbackQuery("Buyurtma topilmadi.");

    if (action === 'pay_click') {
        try {
            // Named parameters xatoliklarni oldini oladi
            await ctx.api.raw.sendInvoice({
                chat_id: ctx.from.id,
                title: i18n[lang].payment_title,
                description: i18n[lang].payment_description.replace('{items}', order.items.substring(0, 100)),
                payload: `order_${ctx.from.id}_${Date.now()}`,
                provider_token: process.env.PROVIDER_TOKEN, // SIZDAGI O'ZGARUVCHI NOMI
                currency: "UZS",
                prices: JSON.stringify([{ label: "Jami", amount: order.price * 100 }])
            });
            await ctx.deleteMessage().catch(() => {});
        } catch (e) {
            console.error("Invoice error:", e);
            await ctx.reply("To'lovni yaratishda xatolik yuz berdi.");
        }
    } else if (action === 'pay_cash') {
        const adminText = `🛍 **YANGI BUYURTMA (NAQD)!**\n\n👤 Mijoz: ${user?.fullName}\n📞 Tel: ${user?.phone}\n📦 Mahsulotlar: ${order.items}\n💰 Jami: ${order.price.toLocaleString()} so'm`;
        await bot.api.sendMessage(process.env.ADMIN_ID, adminText, { parse_mode: "Markdown" });
        await ctx.editMessageText(lang === 'uz' ? "✅ Buyurtmangiz qabul qilindi (Naqd)." : "✅ Заказ принят (Наличные).");
        ctx.session.tempOrder = null;
    }
    await ctx.answerCallbackQuery();
});

// To'lovni tasdiqlash
bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true));

// To'lov muvaffaqiyatli o'tganda
bot.on("message:successful_payment", async (ctx) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.from.id);
    const lang = user?.lang || 'uz';
    await ctx.reply(i18n[lang].payment_success);
    ctx.session.tempOrder = null;
});

// 3. MINI APP DATA
bot.on("message:web_app_data", async (ctx) => {
    try {
        const data = JSON.parse(ctx.message.web_app_data.data);
        if (data.action === "new_order") {
            ctx.session.tempOrder = { items: data.items, price: data.total_price };
            const payKeyboard = new InlineKeyboard()
                .text("💳 Click (Telegram)", "pay_click").row()
                .text("💵 Naqd (Kuryerga)", "pay_cash");

            await ctx.reply(`💰 Summa: ${data.total_price.toLocaleString()} so'm\nTo'lov usulini tanlang:`, {
                reply_markup: payKeyboard
            });
        }
    } catch (e) { console.error(e); }
});

// QOLGAN TEXT MESSAGES (O'zgarishsiz)
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
    } else {
        switch (ctx.message.text) {
            case i18n[lang].order:
                await ctx.reply("Menyuni oching:", {
                    reply_markup: new Keyboard().webApp("🍟 Menyu", `${process.env.WEB_APP_URL}`).resized()
                });
                break;
            case i18n[lang].settings:
                // showSettings funksiyasini yuqorida aniqlagan bo'lishingiz kerak
                const langName = lang === 'uz' ? "O'zbekcha 🇺🇿" : "Русский 🇷🇺";
                let text = i18n[lang].current_data.replace('{name}', user.fullName || '—').replace('{phone}', user.phone || '—').replace('{lang}', langName);
                const keyboard = new InlineKeyboard().text("👤 " + i18n[lang].edit_name, "edit_name").row().text("📞 " + i18n[lang].edit_phone, "edit_phone").row().text("🌐 " + i18n[lang].edit_lang, "edit_lang");
                await ctx.reply(text, { reply_markup: keyboard });
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

// SERVERNI YOQISH
(async () => {
    // Double pollingni o'chirish uchun avvalgi barcha so'rovlarni o'chiramiz
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    
    bot.start();
    app.listen(process.env.PORT || 3000, () => {
        console.log('Bot va Server muvaffaqiyatli ishga tushdi!');
    });
})();
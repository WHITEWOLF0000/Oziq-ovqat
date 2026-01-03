require('dotenv').config();
const { Bot, InlineKeyboard, Keyboard, session } = require("grammy");
const Database = require('better-sqlite3');
const express = require('express');

const db = new Database('avigo.db');
const bot = new Bot(process.env.BOT_TOKEN);
const app = express();

app.use(express.json());

// --- 1. JADVALLARNI SOZLASH ---
db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        fullName TEXT,
        phone TEXT,
        lang TEXT DEFAULT 'uz'
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        items TEXT,
        amount REAL,
        method TEXT,
        date TEXT
    )
`).run();

// AGAR ESKI BAZA BO'LSA, USTUNLARNI TEKSHIRIB QO'SHISH
const columns = ['amount', 'method'];
columns.forEach(col => {
    try {
        db.prepare(`ALTER TABLE orders ADD COLUMN ${col} TEXT`).run();
    } catch (e) {}
});

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
        payment_title: "Buyurtma to'lovi",
        payment_description: "Mahsulotlar: {items}",
        payment_success: "✅ To'lov muvaffaqiyatli amalga oshirildi! Buyurtmangiz tayyorlanmoqda.",
        lets_start: "Let's get started 🍟\n\nPlease tap the button below to order your perfect lunch!"
    },
    ru: {
        welcome: "Добро пожаловать! Введите имя и фамилию:",
        ask_phone: "Отправьте ваш номер телефона:",
        order: "🍟 Заказать",
        settings: "⚙️ Настройки",
        feedback: "📩 Жалобы",
        done: "✅ Данные сохранились!",
        current_data: "📝 Ваши данные:\n\n👤 Имя: {name}\n📞 Тел: {phone}\n🌐 Язык: {lang}",
        edit_name: "Изменить имя",
        payment_title: "Оплата заказа",
        payment_description: "Выбранные товары: {items}",
        payment_success: "✅ Оплата прошла успешно! Ваш заказ готовится.",
        lets_start: "Давайте начнем 🍟\n\nПожалуйста, нажмите кнопку ниже, чтобы заказать идеальный обед!"
    }
};

// --- 2. YORDAMCHI FUNKSIYALAR ---

async function sendOrderNotifications(user, order, methodText) {
    const commonText = `📦 **YANGI BUYURTMA!**\n\n` +
                       `👤 Mijoz: ${user.fullName || "Noma'lum"}\n` +
                       `📞 Tel: ${user.phone || "Noma'lum"}\n` +
                       `🍔 Mahsulotlar: ${order.items}\n` +
                       `💰 Jami: ${Number(order.price).toLocaleString()} so'm\n` +
                       `🏦 To'lov turi: ${methodText}\n` +
                       `⏰ Vaqt: ${new Date().toLocaleString('uz-UZ')}`;

    try {
        db.prepare('INSERT INTO orders (user_id, items, amount, method, date) VALUES (?, ?, ?, ?, ?)')
          .run(user.id, order.items, order.price, methodText, new Date().toISOString());

        if (process.env.ADMIN_ID) {
            await bot.api.sendMessage(process.env.ADMIN_ID, `🏦 **ADMIN:**\n${commonText}`, { parse_mode: "Markdown" });
        }
        if (process.env.KITCHEN_CHANNEL_ID) {
            await bot.api.sendMessage(process.env.KITCHEN_CHANNEL_ID, `👨‍🍳 **OSHPAZLAR:**\n${commonText}`, { parse_mode: "Markdown" });
        }
    } catch (e) {
        console.error("Xabarnoma xatosi:", e.message);
    }
}

const getMainMenu = (lang) => {
    return new Keyboard()
        .text(i18n[lang].order).row()
        .text(i18n[lang].feedback).text(i18n[lang].settings)
        .resized();
};

// --- 3. BOT BUYRUQLARI ---

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

// --- 4. CALLBACKS VA TO'LOV ---

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

bot.callbackQuery(/^pay_/, async (ctx) => {
    const action = ctx.callbackQuery.data;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.from.id);
    const lang = user?.lang || 'uz';
    const order = ctx.session.tempOrder;

    if (!order) return ctx.answerCallbackQuery("Buyurtma topilmadi.");

    if (action === 'pay_click') {
        try {
            const cleanPrice = parseFloat(order.price.toString().replace(/\s/g, ''));
            const priceInTiyin = Math.round(cleanPrice * 100);

            await ctx.api.sendInvoice(
                ctx.from.id,
                i18n[lang].payment_title,
                i18n[lang].payment_description.replace('{items}', order.items.substring(0, 100)),
                `order_${ctx.from.id}_${Date.now()}`,
                process.env.PROVIDER_TOKEN,
                "UZS",
                [{ label: "Jami", amount: priceInTiyin }]
            );
            await ctx.deleteMessage().catch(() => {});
        } catch (e) { 
            console.error("To'lov xatosi:", e.message); 
            await ctx.reply("To'lov tizimida xatolik yuz berdi.");
        }
    } else if (action === 'pay_cash') {
        await sendOrderNotifications(user, order, "💵 Naqd");
        await ctx.editMessageText(lang === 'uz' ? "✅ Buyurtmangiz qabul qilindi (Naqd)." : "✅ Заказ принят (Наличные).");
        ctx.session.tempOrder = null;
    }
    await ctx.answerCallbackQuery();
});

bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true));

bot.on("message:successful_payment", async (ctx) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.from.id);
    const order = ctx.session.tempOrder;
    if (order && user) await sendOrderNotifications(user, order, "💳 Click");
    await ctx.reply(i18n[user?.lang || 'uz'].payment_success);
    ctx.session.tempOrder = null;
});

// --- 5. HANDLINGLAR ---

bot.on("message:web_app_data", async (ctx) => {
    try {
        const data = JSON.parse(ctx.message.web_app_data.data);
        if (data.action === "new_order") {
            ctx.session.tempOrder = { items: data.items, price: data.total_price };
            const payKeyboard = new InlineKeyboard()
                .text("💳 Click", "pay_click").row()
                .text("💵 Naqd", "pay_cash");
            await ctx.reply(`💰 Summa: ${data.total_price.toLocaleString()} so'm\nTo'lov turini tanlang:`, { reply_markup: payKeyboard });
        }
    } catch (e) { console.error(e); }
});

bot.on("message:text", async (ctx) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.from.id);
    const lang = user?.lang || "uz";

    if (ctx.session.step === "ASK_NAME") {
        db.prepare('UPDATE users SET fullName = ? WHERE id = ?').run(ctx.message.text, ctx.from.id);
        ctx.session.step = "ASK_PHONE";
        await ctx.reply(i18n[lang].ask_phone, { reply_markup: new Keyboard().requestContact("📱 Telefon yuborish").resized().oneTime() });
    } 
    // "BUYURTMA BERISH" BOSILGANDA
    else if (ctx.message.text === i18n[lang].order) {
        const orderKeyboard = new InlineKeyboard()
            .webApp("🍟 Menyu", process.env.WEB_APP_URL);

        await ctx.reply(i18n[lang].lets_start, { 
            reply_markup: orderKeyboard 
        });
    } 
    else if (ctx.message.text === i18n[lang].settings) {
        const text = i18n[lang].current_data.replace('{name}', user.fullName || '—').replace('{phone}', user.phone || '—').replace('{lang}', lang);
        await ctx.reply(text, { reply_markup: new InlineKeyboard().text("👤 Ismni o'zgartirish", "edit_name") });
    }
});

bot.on("message:contact", async (ctx) => {
    db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(ctx.message.contact.phone_number, ctx.from.id);
    ctx.session.step = "IDLE";
    const user = db.prepare('SELECT lang FROM users WHERE id = ?').get(ctx.from.id);
    await ctx.reply(i18n[user.lang].done, { reply_markup: getMainMenu(user.lang) });
});

bot.callbackQuery("edit_name", async (ctx) => {
    ctx.session.step = "ASK_NAME";
    await ctx.answerCallbackQuery();
    await ctx.reply("Yangi ismni kiriting:");
});

bot.catch((err) => console.error(`Bot xatosi:`, err.error));

// --- 6. ISHGA TUSHIRISH ---
(async () => {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    bot.start();
    app.listen(process.env.PORT || 3000, () => console.log('✅ Bot tayyor!'));
})();
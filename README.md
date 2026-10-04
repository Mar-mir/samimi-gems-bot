# samimi Gems — ربات شخصی تلگرام (Cloudflare Workers)

مثل Gemهای جمینای: چند دستیار شخصی با دستور (system prompt) دلخواه می‌سازی،
بعد با هرکدوم چت می‌کنی. جواب‌ها از مدل‌های رایگان روتر Nara میاد.
فقط مالک ربات (یک user id) می‌تونه باهاش کار کنه.

قابلیت‌ها:
- ساخت دستیار (`/newgem`) با دستور متنی یا فایل `.txt` / `.md`
- دانش ضمیمه برای هر دستیار (فایل بفرستی به دانش دستیار فعال اضافه می‌شه)
- حافظه مکالمه (۲۰ پیام آخر) + `/reset` برای پاک کردنش
- دکمه «📋 کپی» تک‌ضربه‌ای زیر هر جواب (متن جواب دست نمی‌خوره)
- پیام‌های طولانی پشت‌سرهم به یک جواب واحد ترکیب می‌شن
- لیست مدل‌های رایگان هر هفته خودکار تازه می‌شه (cron)

## پیش‌نیازها

- Node.js 18 به بالا
- اکانت Cloudflare (پلن رایگان کافیه)
- `wrangler`:
  ```
  npm i -g wrangler
  wrangler login
  ```
- یک ربات تلگرام از [@BotFather](https://t.me/BotFather) + توکنش
- کلید Nara router (متغیر `NARA_KEY`)

## راه‌اندازی (۵ دقیقه)

۱. ریپو رو کلون کن و واردش شو:
```
git clone https://github.com/Nassami1/samimi-gems-bot.git
cd samimi-gems-bot
npm install
```

۲. یک KV namespace بساز (فقط یک بار) و id رو در `wrangler.toml` بذار:
```
wrangler kv namespace create GEMS_KV
```
خروجی دو تا id می‌ده (production و preview). id اصلی رو جایگزین `id` فعلی
در بخش `[[kv_namespaces]]` فایل `wrangler.toml` کن.

۳. سکرت‌ها رو ست کن (هیچ‌وقت توکن رو داخل کد نذار):
```
wrangler secret put TOKEN
# توکن ربات تلگرام رو پیست کن

wrangler secret put NARA_KEY
# کلید روتر Nara رو پیست کن
```

۴. آیدی عددی تلگرام خودت رو در `wrangler.toml` بذار:
```toml
ALLOWED_USER_ID = "93255700"
```
(آیدی عددیت رو از [@userinfobot](https://t.me/userinfobot) بگیر.)

۵. دیپلوی:
```
npm run deploy
```
بهت یه URL می‌ده مثل:
`https://samimi-gems-bot.<subdomain>.workers.dev`

۶. وب‌هوک رو یک بار ست کن:
```
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://samimi-gems-bot.<subdomain>.workers.dev"
```

۷. تست: در تلگرام به ربات `/start` بده. جواب `health` هم باید ok باشه:
```
curl https://samimi-gems-bot.<subdomain>.workers.dev/health
```

## دستورها

| دستور | کار |
|---|---|
| `/newgem اسم \| دستور` | ساخت دستیار جدید (دستور بعد `\|` اختیاریه؛ اگه ندی، پیام بعدی دستور می‌شه) |
| `/mygems` | لیست دستیارها |
| `/use اسم` | انتخاب دستیار فعال |
| `/delgem اسم` | حذف دستیار |
| `/reset` | پاک کردن حافظه مکالمه |
| `/model` | دیدن مدل فعلی |
| `/help` | راهنما |

هر پیام عادی = چت با دستیار فعال. فایل `.txt` / `.md` بفرستی به دانش دستیار فعال اضافه می‌شه.

## تنظیم مدل

در `wrangler.toml`:
```toml
MODEL = "mimo-v2.5-free"
NARA_BASE = "https://router.bynara.id/v1"
```
اگه مدل اصلی خطا بده، ربات خودش سراغ بقیه مدل‌های رایگان می‌ره
(هر دوشنبه ساعت ۶ صبح UTC لیست تازه می‌شه — بخش `[triggers]`).

تازه‌سازی دستی:
```
curl https://samimi-gems-bot.<subdomain>.workers.dev/refresh-models
```

## اجرای لوکال (polling، بدون Workers)

اگه نمی‌خوای دیپلوی کنی، همون ورکر با polling هم کار می‌کنه:
```
TOKEN=xxx NARA_KEY=yyy node bot-polling.mjs
```
این حالت وب‌هوک رو پاک می‌کنه و آپدیت‌ها رو با getUpdates می‌گیره.
برای برگشتن به Workers، مرحله ۶ (setWebhook) رو دوباره اجرا کن.

## ساختار

```
src/worker.js      # کل منطق ربات (تلگرام + Nara + KV)
bot-polling.mjs    # اجرای لوکال با polling (سکرت فقط از env)
wrangler.toml      # کانفیگ Workers: vars، KV، cron هفتگی
package.json       # فقط wrangler به‌عنوان devDependency
```

## امنیت

- توکن تلگرام و `NARA_KEY` فقط با `wrangler secret put` ست می‌شن — هرگز داخل کد یا گیت نمی‌رن.
- ربات فقط به یک `ALLOWED_USER_ID` جواب می‌ده؛ بقیه پیام «ربات شخصیه» می‌گیرن.
- اگه توکنت جایی لو رفت، با [@BotFather](https://t.me/BotFather) دستور `/revoke` بزن، توکن جدید بگیر و `wrangler secret put TOKEN` رو تکرار کن.

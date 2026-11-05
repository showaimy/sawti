# صوتي

موقع لتحويل النص إلى صوت: 23 لغة منها العربي، و8 أصوات جاهزة، وتقدر تضيف صوتك.
الصوت يتولّد على سيرفر خاص على [Modal](https://modal.com) بكرت شاشة، وما ينزل أي نموذج على الجهاز.

- الموقع: https://showaimy.github.io/sawti/ (الملفات المبنية في جذر المستودع، ينشرها GitHub Pages)
- الكود المصدري للموقع: `source/` (`npm install` ثم `npx vite build`، وبعدها انسخ محتوى `dist/` للجذر)
- السيرفر: `server/app.py` (Chatterbox Multilingual من Resemble AI، رخصة MIT)

## السيرفر

GitHub Actions (`.github/workflows/deploy-server.yml`) يرفعه على Modal كل ما تغيّر شي في `server/`.
يحتاج ثلاثة أسرار في إعدادات المستودع (Settings > Secrets and variables > Actions):
`MODAL_TOKEN_ID` و`MODAL_TOKEN_SECRET` و`SAWTI_PASSWORD`.

رابط السيرفر: `https://showaimy--sawti.us-east.modal.run`
كرت الشاشة (T4) يشتغل بس وقت التوليد، ويطفي نفسه بعد 3 دقائق بدون استخدام.

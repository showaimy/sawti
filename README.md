# صوتي

موقع لتحويل النص إلى صوت داخل المتصفح، بدون سيرفر وبدون اشتراك.

- **عالي الجودة:** Chatterbox Multilingual (Resemble AI، رخصة MIT). يدعم 23 لغة منها العربي، وفيه أصوات جاهزة، وتقدر تضيف صوتك. يحتاج كمبيوتر فيه كرت شاشة ومتصفح Chrome أو Edge.
- **سريع:** أصوات Piper (رخصة MIT)، وتشتغل حتى على الجوال.

الموقع المبني موجود في جذر المستودع، وGitHub Pages ينشره مباشرة.
والكود المصدري في مجلد `source/`: تشغّل `npm install --ignore-scripts` ثم `npx vite build`، وتنسخ محتوى مجلد `dist/` للجذر.
لاحظ إن ملفات `source/public/wasm` محذوفة من النسخة المصدرية، والموقع المبني يحتويها في مجلد `wasm/`.

## السيرفر (اختياري)

مجلد `server/` فيه سيرفر Chatterbox يشتغل على [Modal](https://modal.com) بكرت شاشة. كرت الشاشة يشتغل بس وقت التوليد ويطفي نفسه بعدها.
يرفعه GitHub Actions تلقائياً (`.github/workflows/deploy-server.yml`) كل ما تغيّر شي في `server/`.

يحتاج ثلاثة أسرار في إعدادات المستودع (Settings > Secrets and variables > Actions):
`MODAL_TOKEN_ID` و`MODAL_TOKEN_SECRET` و`SAWTI_PASSWORD`.

رابط السيرفر: `https://showaimy--sawti.us-east.modal.run`. في الموقع اختر «عالية الجودة»، ثم «السيرفر»، واكتب كلمة المرور.

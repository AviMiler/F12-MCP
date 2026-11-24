# f12-mcp: מסמך דרישות

שרת MCP קטן שנותן ל-Claude Code גישה ללשוניות **Console** ו-**Network** של כלי המפתחים בכרום (F12). הוא מיועד לעבודה במחשב בלי אינטרנט.

---

## 1. מטרה
לאפשר ל-Claude לדבג אפליקציית ווב כמו מפתח שפותח F12:
- לקרוא שגיאות והודעות מהקונסול
- לראות את כל בקשות הרשת, כולל headers, payload ותשובה
- להריץ פקודות JavaScript כמו בקונסול

**לא בתחום:** קריאת ה-DOM, ניווט, לחיצות, צילומי מסך, breakpoints וניתוח ביצועים.

---

## 2. אילוצי סביבה
| אילוץ | משמעות |
|---|---|
| מחשב **בלי אינטרנט** | אסור להשתמש ב-npm install או בחבילות חיצוניות |
| Windows | נתיבים ופקודות הפעלה של Windows |
| **Node.js 22 ומעלה** | נדרש בשביל `WebSocket` המובנה. לבדוק עם `node -v`. ב-Node 21 צריך את הדגל `--experimental-websocket`. מתחת ל-21 צריך לממש WebSocket ידנית |
| **אפס תלויות** | קובץ JS אחד. ה-MCP (JSON-RPC על stdio) ממומש ידנית, בלי SDK |
| כרום או Edge מכל גרסה מהשנים האחרונות | משתמשים רק בפקודות CDP בסיסיות ויציבות |

---

## 3. ארכיטקטורה
```
Claude Code ⇄ (stdio, JSON-RPC) ⇄ f12-mcp.js ⇄ (WebSocket, CDP) ⇄ Chrome :9222
```

1. **כרום מופעל עם פורט דיבאג** בפרופיל נפרד:
   ```
   chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\chrome-debug
   ```
   `--user-data-dir` חובה. בלעדיו, אם כרום כבר פתוח, הדגל לא נכנס לתוקף.
2. **רשימת טאבים:** בקשת HTTP GET ל-`http://127.0.0.1:9222/json/list`.
3. **חיבור לטאב:** WebSocket לכתובת `webSocketDebuggerUrl` של הטאב.
4. **הפעלת דומיינים של CDP:**
   - `Runtime.enable`: אירועי `consoleAPICalled` ו-`exceptionThrown`
   - `Log.enable`: אירועי `entryAdded`, כלומר הודעות דפדפן כמו שגיאות רשת, CSP ואזהרות
   - `Network.enable` עם `maxTotalBufferSize` ו-`maxResourceBufferSize` מוגדלים, כדי שגופי התשובות יישמרו זמן רב יותר
5. **איסוף לזיכרון:** הכלי שומר חוצצים (buffers) של קונסול ורשת לכל טאב, עם תקרה כדי שהזיכרון לא יתנפח, למשל 1000 הודעות ו-500 בקשות.

---

## 4. הכלים (MCP tools)

| כלי | פרמטרים | מה מחזיר |
|---|---|---|
| `list_tabs` | (אין) | מזהה, כותרת וכתובת לכל טאב, ובאיזה טאב הכלי מחובר כרגע |
| `attach` | `tab` (מזהה, או חלק מהכתובת) | מתחבר לטאב ומתחיל לאסוף. כשיש רק טאב אחד, הכלי מתחבר אליו אוטומטית |
| `console` | `level` (error/warn/all), `since` (מזהה או זמן), `limit`, `clear` | שורה לכל הודעה: רמה, טקסט ומיקום בקוד (קובץ:שורה). ל-exceptions מצורף גם stack trace מקוצר |
| `network` | `filter` (api = רק XHR/fetch, או all), `failed_only`, `url_contains`, `limit`, `clear` | **שורה אחת לבקשה:** מזהה, מתודה, כתובת, סטטוס, סוג, גודל וזמן |
| `network_detail` | `id`, `max_body_chars` (ברירת מחדל: 4000) | כל הפרטים של בקשה אחת (ראה סעיף 5) |
| `eval` | `expression` | מריץ JS בדף (`Runtime.evaluate` עם `returnByValue` ו-`awaitPromise`) ומחזיר את התוצאה או את השגיאה |
| `reload` | `ignore_cache` | מרענן את הדף ומנקה את החוצצים, כדי לתפוס הכול מההתחלה |

---

## 5. מה נאסף על כל בקשת רשת
- כתובת, מתודה, סטטוס וטקסט הסטטוס, וסוג המשאב
- Request headers ו-Response headers, כולל המידע המורחב: cookies ו-headers גולמיים דרך `requestWillBeSentExtraInfo` ו-`responseReceivedExtraInfo`
- **Payload:** `request.postData`, ואם הוא חסר, דרך `Network.getRequestPostData`
- **Response body:** דרך `Network.getResponseBody`, **בשליפה עצלה** רק כשמבקשים `network_detail`
- **Initiator:** הקוד ששלח את הבקשה (stack trace)
- זמנים (`timing`), גודל (`encodedDataLength`), האם הגיע מה-cache או מ-Service Worker
- **כשלונות:** `loadingFailed` עם הסיבה (CORS, blocked, canceled וכו')
- הפניות (redirect chain)
- **WebSocket:** מסגרות שנשלחו והתקבלו. זה אופציונלי, אפשר לשלב 2

---

## 6. כללי חיסכון בטוקנים
- `console` ו-`network` מחזירים **שורה אחת לפריט**, ופרטים מלאים רק דרך `network_detail`.
- ברירת המחדל של `network` היא `filter=api`: בלי תמונות, CSS ופונטים.
- גוף תשובה ארוך **נחתך** לפי `max_body_chars`, עם הערה "נחתך, X תווים מתוך Y".
- JSON מוחזר כמו שהוא, בלי ריפוד נוסף.
- **קבצים בינאריים** (תמונות, PDF, פונטים) לא נשלפים, ובמקומם מוחזר `[binary, X KB]`.
- הודעות קונסול זהות שחוזרות ברצף מאוחדות לשורה אחת עם מונה, למשל `(×37)`.

---

## 7. מגבלות ידועות
1. **אירועים מלפני החיבור לא נראים**, בדיוק כמו ב-F12. הפתרון הוא `reload`.
2. **גוף תשובה ישן עלול להימחק** מהזיכרון של כרום. הגדלת החוצץ ב-`Network.enable` מקטינה את הבעיה.
3. **Workers ו-Service Workers** הם targets נפרדים, ולא נכללים בשלב 1. בשלב 2 אפשר להוסיף אותם עם `Target.setAutoAttach`.
4. **אם F12 פתוח באותו טאב**, זה לא מפריע, כי כרום מאפשר כמה לקוחות במקביל.

---

## 8. אבטחה
- הכלי מתחבר רק ל-`127.0.0.1`.
- **פורט הדיבאג נותן שליטה מלאה בדפדפן.** לכן משתמשים רק בפרופיל נפרד (`--user-data-dir`) ולא בפרופיל האישי עם הסיסמאות.
- `eval` מריץ קוד בדף. זו הכוונה, אבל צריך לזכור את זה.

---

## 9. התקנה ושימוש
```
claude mcp add f12 -- node "C:\path\to\f12-mcp.js" --port 9222
claude mcp list
```
פרמטרי שורת פקודה: `--port` (ברירת מחדל: 9222) ו-`--host` (ברירת מחדל: 127.0.0.1).

אופציונלי: להוסיף את `"mcp__f12"` לרשימת `allow` ב-`~/.claude/settings.json`, כדי ש-Claude לא יבקש אישור על כל קריאה.

---

## 10. קריטריונים לסיום (איך בודקים)
מכינים **דף בדיקה מקומי** ושרת Node קטן (גם הוא בלי תלויות) שמייצר:
- `console.log`, `console.warn`, `console.error`, ו-exception שלא נתפס
- בקשת fetch שמצליחה (200 + JSON)
- בקשת fetch שנכשלת (500 + גוף שגיאה)
- בקשת POST עם payload
- בקשה לכתובת שלא קיימת (`loadingFailed`)
- תמונה, כדי לוודא שמזוהה כבינארי

**עובר אם:**
- [ ] `console level=error` מחזיר את השגיאה ואת ה-exception עם קובץ ושורה
- [ ] `network failed_only` מחזיר את בקשת ה-500 ואת הבקשה שנכשלה
- [ ] `network_detail` על בקשת ה-POST מציג headers, payload וגוף תשובה
- [ ] גוף ארוך נחתך עם הערה
- [ ] התמונה מוצגת כ-`[binary]`
- [ ] `eval "1+1"` מחזיר 2, ו-`eval` עם Promise מחזיר את הערך שלו
- [ ] `reload` מנקה את החוצצים ותופס את הבקשות מההתחלה
- [ ] עובד כשכרום נסגר ונפתח מחדש: הכלי מחזיר שגיאה ברורה, ואחרי פתיחה מחדש `attach` מצליח
- [ ] אין אף `require` או `import` של חבילה שאינה מובנית ב-Node

---

## 11. שלב 2 (לא עכשיו)
- הודעות WebSocket
- בקשות של Workers ו-Service Workers
- ייצוא HAR לקובץ
- סקריפט הפעלה (`start-chrome.ps1`) שפותח כרום עם הדגלים הנכונים

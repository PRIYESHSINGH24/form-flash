# FormFlash - one-click form autofill

Google Forms + Microsoft Forms ko ek click me fill karta hai. Data sirf tere browser me rehta hai (chrome.storage.local).

## Install (2 min)
1. Zip extract kar.
2. Chrome me `chrome://extensions` kholo, top-right me **Developer mode** ON.
3. **Load unpacked** dabao, `formflash` folder select karo.
4. Toolbar me puzzle icon se FormFlash pin kar le.

## Use
1. Extension icon dabao -> "Saved answers" me apni details bhar do (keywords + answer). Auto-save hota hai.
2. Koi bhi Google/Microsoft Form kholo. Page ke bottom-right me yellow **Fill form** button aayega (ya popup se "Fill this form").
3. Jo questions match nahi hue, popup me "Needs your answer" me dikhenge. Wahin answer daal ke Save kar do, next time auto-fill.
4. Form khud check karke Submit kar. Extension kabhi submit nahi karta.

## Rules
- Keyword question text me match hota hai: `email` -> "Email address *" me match.
- Sabse lamba matching keyword jeetta hai.
- `=name` matlab poora question exactly "Name" ho tabhi (Father's name pe nahi).
- Radio/dropdown ke liye answer option ke text jaisa likh (ya usse milta-julta).
- Checkbox ke liye commas: `Java, Python`.
- Jo text field pehle se bhara hai use overwrite nahi karta.
- Multi-page form me har page pe button dobara dabao.

## Files
- manifest.json - config (Manifest V3)
- content.js - form pe chalta hai: questions dhoondta hai, match karta hai, fill karta hai
- popup.html/css/js - answers manage karne ka UI, unmatched questions add karna, export/import

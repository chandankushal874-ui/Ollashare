import { chromium, webkit } from "playwright";

const HARNESS = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow-x:hidden;font-family:Arial,sans-serif}button{font:inherit}.room{height:100dvh;display:flex;background:#f1efff;color:#08080b}.stage{min-width:0;flex:1;display:grid;place-items:center;padding:12px}.rail{width:380px;border-left:1px solid #dedee5;background:white;padding:16px}.dock,.backdrop,.sheet{display:none}@media(max-width:900px){.room{padding:env(safe-area-inset-top) env(safe-area-inset-right) calc(72px + env(safe-area-inset-bottom)) env(safe-area-inset-left)}.rail{display:none}.dock{position:fixed;display:flex;left:0;right:0;bottom:0;z-index:3;gap:4px;padding:8px max(8px,env(safe-area-inset-right)) max(8px,env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left));border-top:1px solid #dedee5;background:white}.dock button,.sheet button{min-width:44px;min-height:44px}.dock button{flex:1;border:0;border-radius:12px;background:#f0f1f5}.backdrop.open{position:fixed;display:block;inset:0;z-index:4;border:0;background:#02061777}.sheet.open{position:fixed;display:flex;z-index:5;flex-direction:column;background:white;border:1px solid #dedee5;overflow:hidden}.sheet header{display:flex;align-items:center;justify-content:space-between;min-height:56px;padding:8px 12px;border-bottom:1px solid #dedee5}.sheet .content{min-height:0;overflow-y:auto;padding:12px}.sheet input{min-height:44px;width:100%;font-size:16px}.sheet.portrait{left:0;right:0;bottom:0;max-height:min(78dvh,calc(100dvh - 64px));border-radius:18px 18px 0 0;padding-bottom:env(safe-area-inset-bottom)}.sheet.landscape{top:0;right:0;bottom:0;width:min(380px,88vw);border-radius:18px 0 0 18px;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) 0}}
</style>
</head>
<body>
<main class="room"><section class="stage"><button id="focus" style="min-width:44px;min-height:44px">Focus screen</button></section><aside class="rail" aria-label="Desktop room rail">Desktop rail</aside></main>
<nav class="dock" aria-label="Room controls"><button id="share">Share</button><button id="screens">Screens</button><button id="people">People</button><button id="chat" aria-expanded="false" aria-controls="sheet">Chat</button><button id="more">More</button></nav>
<button class="backdrop" aria-label="Close room panel"></button>
<section id="sheet" class="sheet" role="dialog" aria-modal="true" aria-labelledby="title"><header><h2 id="title">Room chat</h2><button id="close" aria-label="Close Room chat">×</button></header><div class="content"><label>Message<input id="message" /></label><button id="send">Send</button></div></section>
<script>
(()=>{const opener=document.querySelector('#chat');const sheet=document.querySelector('#sheet');const backdrop=document.querySelector('.backdrop');const close=document.querySelector('#close');let returnFocus=null;
function layout(){sheet.classList.toggle('portrait',innerHeight>=innerWidth);sheet.classList.toggle('landscape',innerWidth>innerHeight)}
function openSheet(){opener.focus();returnFocus=document.activeElement;layout();sheet.classList.add('open');backdrop.classList.add('open');opener.setAttribute('aria-expanded','true');close.focus()}
function closeSheet(){sheet.classList.remove('open');backdrop.classList.remove('open');opener.setAttribute('aria-expanded','false');returnFocus?.focus()}
opener.addEventListener('click',openSheet);close.addEventListener('click',closeSheet);backdrop.addEventListener('click',closeSheet);addEventListener('resize',layout);addEventListener('keydown',event=>{if(event.key==='Escape'&&sheet.classList.contains('open')){event.preventDefault();closeSheet()}});})();
</script>
</body></html>`;

async function assertCompact(page, width, height) {
	await page.setViewportSize({ width, height });
	await page.setContent(HARNESS);
	const dock = page.getByRole("navigation", { name: "Room controls" });
	if (!(await dock.isVisible()))
		throw new Error(`${width}x${height}: dock hidden`);
	const targets = await dock.locator("button").evaluateAll((buttons) =>
		buttons.map((button) => {
			const rect = button.getBoundingClientRect();
			return { width: rect.width, height: rect.height };
		}),
	);
	if (targets.some((target) => target.width < 44 || target.height < 44))
		throw new Error(`${width}x${height}: control below 44px`);
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth >
			document.documentElement.clientWidth,
	);
	if (overflow) throw new Error(`${width}x${height}: horizontal overflow`);
	await page.getByRole("button", { name: "Chat" }).click();
	const sheet = page.getByRole("dialog", { name: "Room chat" });
	if (!(await sheet.isVisible()))
		throw new Error(`${width}x${height}: sheet hidden`);
	const box = await sheet.boundingBox();
	if (!box) throw new Error(`${width}x${height}: no sheet box`);
	if (height >= width) {
		if (Math.abs(box.y + box.height - height) > 2)
			throw new Error(
				`${width}x${height}: portrait sheet is not bottom anchored`,
			);
	} else {
		if (Math.abs(box.x + box.width - width) > 2 || box.width > 380.5)
			throw new Error(
				`${width}x${height}: landscape sheet is not bounded right`,
			);
	}
	if ((await page.evaluate(() => document.activeElement?.id)) !== "close")
		throw new Error(`${width}x${height}: close button did not receive focus`);
	await page.keyboard.press("Escape");
	await page.waitForTimeout(50);
	if ((await page.evaluate(() => document.activeElement?.id)) !== "chat")
		throw new Error(`${width}x${height}: focus did not return to opener`);
}

async function assertDesktop(page) {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.setContent(HARNESS);
	if (await page.getByRole("navigation", { name: "Room controls" }).isVisible())
		throw new Error("desktop: compact dock visible");
	const rail = page.getByRole("complementary", { name: "Desktop room rail" });
	if (!(await rail.isVisible())) throw new Error("desktop: right rail hidden");
	const box = await rail.boundingBox();
	if (!box || Math.abs(box.width - 380) > 1)
		throw new Error("desktop: right rail is not 380px");
}

for (const [name, browserType] of [
	["chromium", chromium],
	["webkit", webkit],
]) {
	const browser = await browserType.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await assertCompact(page, 390, 844);
		await assertCompact(page, 844, 390);
		await assertDesktop(page);
		console.log(`${name}: portrait, landscape, and desktop checks passed`);
	} finally {
		await browser.close();
	}
}

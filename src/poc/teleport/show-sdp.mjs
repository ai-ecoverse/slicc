import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(`<html><body><script>
  window.getOffer = async () => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.createDataChannel("session");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise(r => { 
      if (pc.iceGatheringState === "complete") r();
      else pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && r();
    });
    return JSON.stringify({ sdp: pc.localDescription });
  };
</script></body></html>`);

const offer = await page.evaluate(() => window.getOffer());
const parsed = JSON.parse(offer);

console.log('=== RAW SDP OFFER (' + offer.length + ' bytes) ===\n');
console.log(parsed.sdp.sdp);
console.log('\n=== BASE64 ENCODED (for copy/paste) ===\n');
const b64 = Buffer.from(offer).toString('base64');
console.log(b64);
console.log('\n=== LENGTH: ' + b64.length + ' characters ===');

await browser.close();

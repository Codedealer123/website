const SERVICE_UUID = 0x8193;
const CHARACTERISTIC_UUID = 0x9742;
const MAX_POINTS = 10000;

let device=null, characteristic=null, readings=[], packets=0, invalid=0, missing=0;
let lastPacketMs=null, lastReadingMs=null, selectedWindow="live";

const $=id=>document.getElementById(id);
const n=(v,d=1)=>Number.isFinite(Number(v))?Number(v).toFixed(d):"--";
const fmt=v=>Number.isFinite(v)?v.toFixed(1):"--";

function setConnected(connected){
  $("dot").classList.toggle("connected",connected);
  $("status").textContent=connected?"Connected":"Disconnected";
  $("connect").textContent=connected?"Disconnect":"Connect";
  $("bleHealth").textContent=connected?"Connected":"Disconnected";
}
function saturationPressure(t){return 0.6108*Math.exp((17.27*t)/(t+237.3))}
function dewPoint(t,rh){const a=17.27,b=237.3;const g=Math.log(Math.max(rh,0.01)/100)+(a*t)/(b+t);return b*g/(a-g)}
function absoluteHumidity(t,rh){return 216.7*((rh/100)*(6.112*Math.exp((17.67*t)/(t+243.5))))/(t+273.15)}
function vaporPressure(t,rh){return saturationPressure(t)*rh/100}
function vpd(t,rh){return Math.max(0,saturationPressure(t)*(1-rh/100))}
function humidex(t,rh){const e=6.11*Math.exp(5417.7530*(1/273.16-1/(273.15+t)))*rh/100;return t+0.5555*(e-10)}
function heatIndex(t,rh){
  const F=t*9/5+32;
  if(F<80)return t;
  const hi=-42.379+2.04901523*F+10.14333127*rh-0.22475541*F*rh-0.00683783*F*F-0.05481717*rh*rh+0.00122874*F*F*rh+0.00085282*F*rh*rh-0.00000199*F*F*rh*rh;
  return (hi-32)*5/9;
}
function feelsLike(t,rh,hi,dp){
  if(t<=10) return windlessColdFeels(t); // simple indoor-style cold proxy
  if(t>=27 && rh>=40) return hi;
  return t;
}
function windlessColdFeels(t){return t}

function handleData(event){
  try{
    const text=new TextDecoder().decode(event.target.value);
    const data=JSON.parse(text);
    const t=Number(data.temp), rh=Number(data.rh);
    if(!Number.isFinite(t)||!Number.isFinite(rh)||rh<0||rh>100||t<-60||t>80){
      invalid++; $("invalid").textContent=invalid; updateHealth(); return;
    }
    const now=Date.now(), prev=readings.at(-1);
    if(prev){
      const gap=now-prev.ts;
      if(gap>5000) missing+=Math.max(0,Math.round(gap/2000)-1);
    }
    packets++; lastPacketMs=now; lastReadingMs=now;
    const dp=dewPoint(t,rh), vp=vaporPressure(t,rh), av=absoluteHumidity(t,rh), vd=vpd(t,rh);
    const hi=Number.isFinite(Number(data.hi))?Number(data.hi):heatIndex(t,rh);
    const hmdx=Number.isFinite(Number(data.hmdx))?Number(data.hmdx):humidex(t,rh);
    const feels=feelsLike(t,rh,hi,dp);
    readings.push({ts:now,temp:t,rh,dew:dp,hi,hmdx,feels,vpd:vd,abs:av,vp});
    if(readings.length>MAX_POINTS)readings.shift();
    localStorage.setItem("esp32WeatherReadings",JSON.stringify(readings.slice(-3000)));
    render(data);
  }catch(e){invalid++;$("invalid").textContent=invalid;$("error").textContent="Could not parse BLE packet: "+e.message;updateHealth()}
}

function render(raw){
  const r=readings.at(-1); if(!r)return;
  $("temp").textContent=n(r.temp);$("rh").textContent=n(r.rh)+"%";$("rh2").textContent=n(r.rh);
  $("heroTemp").textContent=n(r.temp);$("feels").textContent=n(r.feels)+"°C";$("feels2").textContent=n(r.feels);
  $("hi").textContent=n(r.hi)+"°C";$("hi2").textContent=n(r.hi);$("hmdx").textContent=n(r.hmdx);
  $("dew").textContent=n(r.dew);$("abs").textContent=n(r.abs);$("vpd").textContent=n(r.vpd,2);
  $("updated").textContent="Updated "+new Date(r.ts).toLocaleTimeString();
  $("lastPacket").textContent=new Date(r.ts).toLocaleTimeString();$("healthLast").textContent=new Date(r.ts).toLocaleTimeString();
  $("packets").textContent=packets;$("missing").textContent=missing;$("invalid").textContent=invalid;
  $("raw").textContent=JSON.stringify(raw,null,2);$("error").textContent="";
  $("comfort").textContent=comfort(r.temp,r.rh,r.dew);
  updateTrends();updateStats();updateForecast();updateAlerts();updateHealth();drawCharts();
}
function comfort(t,rh,dp){
  if(t<16)return"Cool";
  if(t>30||rh>80||dp>24)return"Uncomfortable";
  if(t>=20&&t<=26&&rh>=35&&rh<=65)return"Comfortable";
  return"Moderate";
}
function pointsFor(ms){
  const cutoff=Date.now()-ms;
  return readings.filter(x=>x.ts>=cutoff);
}
function deltaAgo(key,ms){
  const cur=readings.at(-1);if(!cur)return null;
  const target=cur.ts-ms;let best=null;
  for(const r of readings){if(r.ts<=target)best=r;else break}
  return best?cur[key]-best[key]:null;
}
function rate(key,ms=3600000){
  const d=deltaAgo(key,ms);return d===null?null:d/(ms/60000);
}
function trendText(v,unit=""){
  if(v===null||!Number.isFinite(v))return"—";
  return (v>0?"↑ ":"")+(v<0?"↓ ":"")+Math.abs(v).toFixed(2)+(unit?" "+unit:"");
}
function updateTrends(){
  const rt=rate("temp"),rh=rate("rh");
  $("tRate").textContent=rt===null?"--":trendText(rt);
  $("hRate").textContent=rh===null?"--":trendText(rh);
  const d5=deltaAgo("temp",300000),d15=deltaAgo("temp",900000),d60=deltaAgo("temp",3600000);
  $("t5").textContent=d5===null?"--":trendText(d5);
  $("t15").textContent=d15===null?"--":trendText(d15);
  $("t60").textContent=d60===null?"--":trendText(d60);
  $("hiTrend").textContent=trendText(rate("hi"));
  $("dewTrend").textContent=trendText(rate("dew"));
  $("rhTrend").textContent=trendText(rate("rh"));
  $("tempTrend").textContent=rt===null?"—":(rt>=0?"↑ Rising":"↓ Falling");
  $("humidityTrend").textContent=rh===null?"—":(rh>=0?"↑ Rising":"↓ Falling");
}
function stats(arr,key){
  if(!arr.length)return null;const a=arr.map(x=>x[key]).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!a.length)return null;const avg=a.reduce((x,y)=>x+y,0)/a.length,med=a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;
  const variance=a.reduce((s,x)=>s+(x-avg)**2,0)/a.length;
  return{min:a[0],max:a.at(-1),avg,median:med,range:a.at(-1)-a[0],sd:Math.sqrt(variance),variance};
}
function updateStats(){
  let arr=selectedWindow==="hour"?pointsFor(3600000):selectedWindow==="day"?pointsFor(86400000):selectedWindow==="week"?pointsFor(604800000):readings;
  const s=stats(arr,"temp");
  const labels=[["Minimum",s?.min],["Maximum",s?.max],["Average",s?.avg],["Median",s?.median],["Range",s?.range],["Std. Deviation",s?.sd],["Variance",s?.variance]];
  $("tempStats").innerHTML=labels.map(([k,v])=>`<div class="stat"><span>${k}</span><b>${v===undefined||v===null?"--":n(v)}</b></div>`).join("");
  $("readingCount").textContent=arr.length;
  $("dataRange").textContent=arr.length?`${new Date(arr[0].ts).toLocaleTimeString()} – ${new Date(arr.at(-1).ts).toLocaleTimeString()}`:"--";
}
function linearForecast(key,minutes){
  const arr=pointsFor(3600000);if(arr.length<3)return null;
  const t0=arr[0].ts;let sx=0,sy=0,sxx=0,sxy=0;
  for(const r of arr){const x=(r.ts-t0)/60000,y=r[key];sx+=x;sy+=y;sxx+=x*x;sxy+=x*y}
  const n=arr.length,den=n*sxx-sx*sx;if(!den)return null;
  const slope=(n*sxy-sx*sy)/den,intercept=(sy-slope*sx)/n;
  return slope*((Date.now()-t0)/60000+minutes)+intercept;
}
function updateForecast(){
  [["forecastT30","temp",30],["forecastT60","temp",60],["forecastH30","rh",30],["forecastH60","rh",60]].forEach(([id,k,m])=>{const v=linearForecast(k,m);$(id).textContent=v===null?"--":n(v)+(k==="temp"?"°C":"%")});
}
function updateAlerts(){
  const r=readings.at(-1), a=[];if(!r)return;
  const highT=+$("highTemp").value,lowT=+$("lowTemp").value,highH=+$("highHumidity").value,lowH=+$("lowHumidity").value,highHI=+$("highHI").value,highD=+$("highDew").value;
  if(r.temp>highT)a.push(`High temperature: ${n(r.temp)}°C`);
  if(r.temp<lowT)a.push(`Low temperature: ${n(r.temp)}°C`);
  if(r.rh>highH)a.push(`High humidity: ${n(r.rh)}%`);
  if(r.rh<lowH)a.push(`Low humidity: ${n(r.rh)}%`);
  if(r.hi>highHI)a.push(`High heat index: ${n(r.hi)}°C`);
  if(r.dew>highD)a.push(`High dew point: ${n(r.dew)}°C`);
  const d=rate("temp",60000);if(d!==null&&Math.abs(d)>1)a.push(`Rapid temperature change: ${n(d)}°C/min`);
  if(!device?.gatt?.connected)a.push("Sensor disconnected");
  $("alerts").innerHTML=a.length?a.map(x=>`<div class="alert">${x}</div>`).join(""):'<div class="empty">No active alerts</div>';
}
function updateHealth(){
  $("bleHealth").textContent=device?.gatt?.connected?"Connected":"Disconnected";
  $("quality").textContent=packets?`${Math.max(0,100-(invalid/Math.max(1,packets+invalid))*100).toFixed(0)}%`:"--";
}
function drawChart(canvasId,key,label){
  const c=$(canvasId),ctx=c.getContext("2d"),rect=c.getBoundingClientRect(),dpr=devicePixelRatio||1;
  c.width=rect.width*dpr;c.height=260*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);
  const w=rect.width,h=260,arr=selectedWindow==="hour"?pointsFor(3600000):selectedWindow==="day"?pointsFor(86400000):selectedWindow==="week"?pointsFor(604800000):readings;
  ctx.clearRect(0,0,w,h);ctx.font="11px system-ui";ctx.fillStyle="#8a9397";
  if(arr.length<2){ctx.fillText("Waiting for more readings…",15,30);return}
  const vals=arr.map(x=>x[key]),min=Math.min(...vals),max=Math.max(...vals),pad=Math.max(.5,(max-min)*.12),lo=min-pad,hi=max+pad;
  for(let i=0;i<5;i++){const y=20+i*(h-45)/4;ctx.strokeStyle="#edf0f1";ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();ctx.fillStyle="#8a9397";ctx.fillText((hi-(hi-lo)*i/4).toFixed(1),5,y-4)}
  ctx.strokeStyle="#202427";ctx.lineWidth=2;ctx.beginPath();
  arr.forEach((r,i)=>{const x=i*(w-10)/(arr.length-1)+5,y=20+(h-45)*(1-(r[key]-lo)/(hi-lo));i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();
}
function drawCharts(){drawChart("tempChart","temp","Temperature");drawChart("humidityChart","rh","Humidity")}
async function connect(){
  if(!navigator.bluetooth){$("error").textContent="Web Bluetooth is not supported by this browser.";return}
  try{
    $("error").textContent="";$("status").textContent="Selecting device...";
    device=await navigator.bluetooth.requestDevice({acceptAllDevices:true,optionalServices:[SERVICE_UUID]});
    device.addEventListener("gattserverdisconnected",()=>{setConnected(false);characteristic=null;updateAlerts()});
    const server=await device.gatt.connect(),service=await server.getPrimaryService(SERVICE_UUID);
    characteristic=await service.getCharacteristic(CHARACTERISTIC_UUID);
    await characteristic.startNotifications();characteristic.addEventListener("characteristicvaluechanged",handleData);
    setConnected(true);$("status").textContent="Connected to "+(device.name||"ESP32");updateAlerts();
  }catch(e){setConnected(false);$("error").textContent=e.message||String(e)}
}
function disconnect(){try{if(device?.gatt?.connected)device.gatt.disconnect()}finally{setConnected(false)}}
$("connect").addEventListener("click",()=>device?.gatt?.connected?disconnect():connect());
document.querySelectorAll(".history-buttons button").forEach(b=>b.addEventListener("click",()=>{selectedWindow=b.dataset.window;document.querySelectorAll(".history-buttons button").forEach(x=>x.classList.remove("active"));b.classList.add("active");updateStats();drawCharts()}));
["highTemp","lowTemp","highHumidity","lowHumidity","highHI","highDew"].forEach(id=>$(id).addEventListener("input",updateAlerts));
try{readings=JSON.parse(localStorage.getItem("esp32WeatherReadings")||"[]")}catch{readings=[]}
if(readings.length){const r=readings.at(-1);render({temp:r.temp,rh:r.rh,hmdx:r.hmdx,hi:r.hi});}
setInterval(()=>{updateAlerts();updateTrends();updateForecast();updateHealth()},2000);
window.addEventListener("resize",drawCharts);

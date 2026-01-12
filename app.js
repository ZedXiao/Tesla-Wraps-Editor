// 简单 contract
// - 输入: models.json（模型列表）
// - 输出: 可在画布上叠加贴膜并导出 PNG

const canvas = document.getElementById('editorCanvas');
const ctx = canvas.getContext('2d');
// debug toggle: set to true to log pointer/hit-test diagnostics in console
const HIT_DEBUG = false;

// Responsive canvas: fill available left area and set backing store size for crispness
function adjustCanvasForLayout(){
	try{
		const wrap = canvas.parentElement; // .canvas-wrap
		const computed = window.getComputedStyle(wrap);
		const padLeft = parseFloat(computed.paddingLeft||0);
		const padRight = parseFloat(computed.paddingRight||0);
		const availW = Math.max(200, wrap.clientWidth - padLeft - padRight);
		const dpr = window.devicePixelRatio || 1;
		// choose height based on template aspect ratio if available, else fallback to 1000x600
		const aspect = (templateImg && templateImg.complete && templateImg.naturalWidth) ? (templateImg.naturalHeight / templateImg.naturalWidth) : (600/1000);
		const displayW = Math.min(availW, 920);
		const displayH = Math.max(200, Math.round(displayW * aspect));
		canvas.style.width = displayW + 'px';
		canvas.style.height = displayH + 'px';
		canvas.width = Math.round(displayW * dpr);
		canvas.height = Math.round(displayH * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // scale drawing to CSS pixels
	}catch(e){ console.warn('adjustCanvasForLayout failed', e); }
}

window.addEventListener('resize', ()=>{ adjustCanvasForLayout(); draw(); });
const modelSelect = document.getElementById('modelSelect');
const vehiclePreview = document.getElementById('vehiclePreview');
const thumbs = document.getElementById('thumbs');
const scaleInput = document.getElementById('scale');
const rotateInput = document.getElementById('rotate');
const opacityInput = document.getElementById('opacity');
const scaleNumber = document.getElementById('scaleNumber');
const rotateNumber = document.getElementById('rotateNumber');
const opacityNumber = document.getElementById('opacityNumber');
const posXInput = document.getElementById('posX');
const posYInput = document.getElementById('posY');
const fillColorInput = document.getElementById('fillColor');
const layerColorInput = document.getElementById('layerColor');
const addFillBtn = document.getElementById('addFillBtn');
const addFillRegionsBtn = document.getElementById('addFillRegionsBtn');
const regionThreshold = document.getElementById('regionThreshold');
const regionThresholdNumber = document.getElementById('regionThresholdNumber');
const exportBtn = document.getElementById('exportBtn');
const quickExportUsb = document.getElementById('quickExportUsb');
// create toast container
let toastContainer = document.querySelector('.toast-container');
if (!toastContainer) {
	toastContainer = document.createElement('div'); toastContainer.className = 'toast-container'; document.body.appendChild(toastContainer);
}

function showToast(text, kind='info', timeout=3500){
	const t = document.createElement('div'); t.className = 'toast ' + (kind||'info'); t.textContent = text; toastContainer.appendChild(t);
	// trigger show
	requestAnimationFrame(()=>{ t.classList.add('show'); });
	if (timeout > 0){ setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>t.remove(),250); }, timeout); }
}
// generate a unique suggested filename for exports to avoid overwriting
function makeSuggestedName(size){
	const base = (currentModelKey || 'wrap');
	let uid = '';
	try{
		if (typeof crypto !== 'undefined' && crypto.randomUUID) uid = crypto.randomUUID().split('-')[0];
		else uid = Date.now().toString(36);
	}catch(e){ uid = Date.now().toString(36); }
	return `${base}-${size}x${size}-${uid}.png`;
}
let fitBtn = document.getElementById('fitBtn');
if (!fitBtn) fitBtn = document.getElementById('fitBtn2');
const resetBtn = document.getElementById('resetBtn');
const bringFront = document.getElementById('bringFront');
const removeWrap = document.getElementById('removeWrap');
// upload controls (hidden input + button + filename display)
const uploadInput = document.getElementById('uploadInput');
const uploadBtnEl = document.getElementById('uploadBtn');
const uploadName = document.getElementById('uploadName');
if (uploadBtnEl && uploadInput) {
	uploadBtnEl.addEventListener('click', ()=>{ uploadInput.click(); });
	uploadInput.addEventListener('change', ()=>{
		const f = uploadInput.files && uploadInput.files[0];
		uploadName.textContent = f ? f.name : '';
		if (f) addUploadedLayer(f);
	});
}

let models = {};
let currentModelKey = null;
let templateImg = new Image();
let vehicleImg = new Image();
let layers = []; // array of {id, img, scale, rotate, opacity, x, y, visible}
let selectedLayer = -1; // index into layers

let layerIdCounter = 1;

// small reusable 1x1 canvas for pixel probing (used by hit-testing)
const pixelProbe = document.createElement('canvas'); pixelProbe.width = 1; pixelProbe.height = 1; const pixelProbeCtx = pixelProbe.getContext('2d');

	function fitSelectedToTemplate() {
		if (selectedLayer < 0 || !layers[selectedLayer] || !templateImg.width) return;
		const w = layers[selectedLayer];
		const tW = templateImg.width, tH = templateImg.height;
		w.scale = Math.min(tW / w.img.width, tH / w.img.height);
		w.x = tW/2; w.y = tH/2; draw();
	}

	function resetAll(){
		scaleInput.value = 1; rotateInput.value = 0; opacityInput.value = 1;
		layers = []; selectedLayer = -1; renderLayerList(); draw();
	}

async function exportAtSize(size){
		if (!(templateImg && templateImg.complete && templateImg.naturalWidth)) { alert('模板未加载，无法导出'); return; }
		// build offscreen at requested square size
		const target = Math.max(1, parseInt(size,10) || 1024);
		// Compose in template pixel space, then scale to target
		const baseW = templateImg.width, baseH = templateImg.height;
		const off = document.createElement('canvas'); off.width = baseW; off.height = baseH; const offCtx = off.getContext('2d');
		offCtx.clearRect(0,0,off.width,off.height);

		// draw layers in order into base template space
				layers.forEach((lay)=>{
					if (!lay.visible) return;
					offCtx.save(); offCtx.globalAlpha = lay.opacity;
					const cx = (lay.x || baseW/2);
					const cy = (lay.y || baseH/2);
					offCtx.translate(cx, cy);
					offCtx.rotate((lay.rotate || 0) * Math.PI/180);
					// prefer rasterCanvas (synchronous) for recolorable layers
					const src = lay.rasterCanvas || lay.img;
					if (!src) { offCtx.restore(); return; }
					const w = ( (src.width || lay.img.width) * (lay.scale||1));
					const h = ( (src.height || lay.img.height) * (lay.scale||1));
					offCtx.drawImage(src, -w/2, -h/2, w, h);
					offCtx.restore();
				});

		// mask with template alpha
		try{
			const probe = document.createElement('canvas'); probe.width = baseW; probe.height = baseH; const pCtx = probe.getContext('2d');
			pCtx.drawImage(templateImg,0,0);
			// use destination-in
			offCtx.globalCompositeOperation = 'destination-in'; offCtx.drawImage(templateImg,0,0);
		}catch(e){ console.warn('mask failed during export', e); offCtx.globalCompositeOperation = 'destination-in'; offCtx.drawImage(templateImg,0,0); }

		// scale to target square canvas
		const out = document.createElement('canvas'); out.width = target; out.height = target; const outCtx = out.getContext('2d');
		// draw off into out, fitting template centered and preserving aspect
		const scale = Math.min(target / baseW, target / baseH);
		const dw = baseW * scale, dh = baseH * scale;
		const dx = (target - dw)/2, dy = (target - dh)/2;
		outCtx.fillStyle = '#0000'; outCtx.clearRect(0,0,target,target);
		outCtx.drawImage(off, 0, 0, baseW, baseH, dx, dy, dw, dh);

		// save out canvas as blob
		try{
			const blob = await new Promise(res=>out.toBlob(res,'image/png'));
			if (window.showSaveFilePicker) {
				const opts = { types: [{ description: 'PNG Image', accept: {'image/png':['.png']} }], suggestedName: makeSuggestedName(target) };
				const handle = await window.showSaveFilePicker(opts);
				const writable = await handle.createWritable();
				await writable.write(blob);
				await writable.close();
			} else {
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a'); a.href = url; a.download = makeSuggestedName(target);
				document.body.appendChild(a); a.click(); a.remove();
				URL.revokeObjectURL(url);
			}
		}catch(err){
			if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError' || err.name === 'SecurityError')){ console.log('save cancelled'); }
			else { console.error('export failed', err); alert('导出失败：' + (err && err.message)); }
		}
}

function draw(showHandles = true){
	// Use CSS pixel coordinates for layout so high-DPI (devicePixelRatio) works correctly.
	const dpr = window.devicePixelRatio || 1;
	const cssW = canvas.width / dpr;
	const cssH = canvas.height / dpr;
	// clear (clear in CSS pixels; the canvas context transform is already set to map CSS->device pixels)
	ctx.clearRect(0, 0, cssW, cssH);
	if (!(templateImg && templateImg.complete && templateImg.naturalWidth)) return;

	// calculate scale to fit canvas while preserving template aspect (use CSS pixel space)
	const scale = Math.min(cssW / templateImg.width, cssH / templateImg.height);
	const drawW = templateImg.width * scale;
	const drawH = templateImg.height * scale;
	const offsetX = (cssW - drawW) / 2;
	const offsetY = (cssH - drawH) / 2;
	// draw template as background (coordinates in CSS pixels; ctx is scaled by dpr in adjustCanvasForLayout)
	ctx.drawImage(templateImg, offsetX, offsetY, drawW, drawH);

	// draw all layers onto offscreen then mask
	if (layers.length) {
		const off = document.createElement('canvas');
		off.width = templateImg.width; off.height = templateImg.height;
		const offCtx = off.getContext('2d'); offCtx.clearRect(0,0,off.width,off.height);

		// draw layers in order
		layers.forEach((lay)=>{
			if (!lay.visible) return;
			offCtx.save(); offCtx.globalAlpha = lay.opacity;
			const cx = (lay.x || templateImg.width/2);
			const cy = (lay.y || templateImg.height/2);
			offCtx.translate(cx, cy);
			offCtx.rotate((lay.rotate || 0) * Math.PI/180);
			const src = lay.rasterCanvas || lay.img;
			if (!src) { offCtx.restore(); return; }
			const w = ((src.width || lay.img.width) * (lay.scale||1));
			const h = ((src.height || lay.img.height) * (lay.scale||1));
			offCtx.drawImage(src, -w/2, -h/2, w, h);
			offCtx.restore();
		});

		// mask offscreen with template (use destination-in by default)
		try {
			const probe = document.createElement('canvas');
			probe.width = Math.max(1, Math.floor(templateImg.width));
			probe.height = Math.max(1, Math.floor(templateImg.height));
			const pCtx = probe.getContext('2d'); pCtx.drawImage(templateImg, 0, 0);
			// sample center area
			const midX = Math.floor(probe.width/2), midY = Math.floor(probe.height/2);
			let sumAlpha = 0, count = 0;
			for (let dx=-2; dx<=2; dx++) for (let dy=-2; dy<=2; dy++){
				const x = Math.min(probe.width-1, Math.max(0, midX+dx));
				const y = Math.min(probe.height-1, Math.max(0, midY+dy));
				const d = pCtx.getImageData(x,y,1,1).data; sumAlpha += d[3]; count++; }
			const avg = sumAlpha / Math.max(1,count);
			const useDestinationIn = avg <= 10;
			if (useDestinationIn) { offCtx.globalCompositeOperation = 'destination-in'; offCtx.drawImage(templateImg,0,0); }
			else { offCtx.globalCompositeOperation = 'destination-out'; offCtx.drawImage(templateImg,0,0); }
		} catch (e) { offCtx.globalCompositeOperation = 'destination-in'; offCtx.drawImage(templateImg,0,0); }

		ctx.drawImage(off, offsetX, offsetY, drawW, drawH);
	}

			// render selection handles for selected layer (only for UI, not for export)
		if (showHandles) renderSelectionHandles();
}

	// reactive inputs - operate on selected layer
	function syncInputsFromLayer(){
		const l = layers[selectedLayer];
		if (!l) return;
		scaleInput.value = l.scale; scaleNumber.value = l.scale;
		rotateInput.value = l.rotate; rotateNumber.value = l.rotate;
		opacityInput.value = l.opacity; opacityNumber.value = l.opacity;
		posXInput.value = Math.round(l.x); posYInput.value = Math.round(l.y);
	}

	scaleInput.addEventListener('input', ()=>{ if(selectedLayer>=0 && layers[selectedLayer]){ layers[selectedLayer].scale = parseFloat(scaleInput.value); scaleNumber.value = scaleInput.value; draw(); }});
	scaleNumber.addEventListener('input', ()=>{ if(selectedLayer>=0 && layers[selectedLayer]){ layers[selectedLayer].scale = parseFloat(scaleNumber.value); scaleInput.value = scaleNumber.value; draw(); }});
	rotateInput.addEventListener('input', ()=>{ if(selectedLayer>=0 && layers[selectedLayer]){ layers[selectedLayer].rotate = parseFloat(rotateInput.value); rotateNumber.value = rotateInput.value; draw(); }});
	rotateNumber.addEventListener('input', ()=>{ if(selectedLayer>=0 && layers[selectedLayer]){ layers[selectedLayer].rotate = parseFloat(rotateNumber.value); rotateInput.value = rotateNumber.value; draw(); }});
	opacityInput.addEventListener('input', ()=>{ if(selectedLayer>=0 && layers[selectedLayer]){ layers[selectedLayer].opacity = parseFloat(opacityInput.value); opacityNumber.value = opacityInput.value; draw(); }});
	opacityNumber.addEventListener('input', ()=>{ if(selectedLayer>=0 && layers[selectedLayer]){ layers[selectedLayer].opacity = parseFloat(opacityNumber.value); opacityInput.value = opacityNumber.value; draw(); }});
	posXInput.addEventListener('input', ()=>{ if(selectedLayer>=0 && layers[selectedLayer]){ layers[selectedLayer].x = parseFloat(posXInput.value); draw(); }});
	posYInput.addEventListener('input', ()=>{ if(selectedLayer>=0 && layers[selectedLayer]){ layers[selectedLayer].y = parseFloat(posYInput.value); draw(); }});

		// add fill layer: generate a canvas matching template size, fill with color, mask by template alpha
		addFillBtn.addEventListener('click', ()=>{
			if (!templateImg || !templateImg.complete) { alert('请先选择车型并加载模板'); return; }
			const color = fillColorInput.value || '#ff0000';
			// create offscreen canvas same size as template
			const off = document.createElement('canvas'); off.width = templateImg.width; off.height = templateImg.height;
			const octx = off.getContext('2d');
			// fill color
			octx.fillStyle = color; octx.fillRect(0,0,off.width,off.height);
			// mask with template alpha (destination-in)
			try{
				octx.globalCompositeOperation = 'destination-in';
				octx.drawImage(templateImg, 0, 0);
			}catch(e){ /* if CORS blocks, warn user */ console.warn('mask failed', e); }

			// create mask canvas and store as recolorable layer (keep mask so color can be changed later)
			const maskCanvas = document.createElement('canvas'); maskCanvas.width = off.width; maskCanvas.height = off.height; const mctx = maskCanvas.getContext('2d');
			// draw template alpha onto mask (we already applied destination-in on off)
			mctx.clearRect(0,0,maskCanvas.width, maskCanvas.height);
			mctx.drawImage(off,0,0);
			const id = layerIdCounter++;
			// create placeholder img to render; we'll recolor immediately
			const img = new Image(); img.crossOrigin='anonymous';
			// set img size so other logic (hit testing/fit) can use dimensions
			img.width = maskCanvas.width; img.height = maskCanvas.height;
			const lay = {id, name:'Fill ' + id, img, maskCanvas, recolorable:true, color: color, scale:1, rotate:0, opacity:1, x: templateImg.width/2, y: templateImg.height/2, visible:true};
			layers.push(lay); selectedLayer = layers.length-1; renderLayerList(); syncInputsFromLayer();
			// apply color to create actual image
			applyColorToLayer(lay, color);
			draw();
		});

		// helper: convert hex color (#rrggbb) to rgb array
		function hexToRgb(hex){
			h = hex.replace('#',''); if (h.length===3) h = h.split('').map(c=>c+c).join('');
			const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
			return [r,g,b];
		}

		// apply a color to a recolorable layer using its maskCanvas
		function applyColorToLayer(layer, color){
			if (!layer || !layer.maskCanvas) return;
			const mc = layer.maskCanvas;
			const w = mc.width, h = mc.height;
			// create or reuse rasterCanvas on layer
			if (!layer.rasterCanvas) { layer.rasterCanvas = document.createElement('canvas'); }
			layer.rasterCanvas.width = w; layer.rasterCanvas.height = h;
			const tctx = layer.rasterCanvas.getContext('2d');
			// fill with color
			const col = hexToRgb(color || '#ff0000');
			tctx.clearRect(0,0,w,h);
			tctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
			tctx.fillRect(0,0,w,h);
			// apply mask using destination-in
			try{
				tctx.globalCompositeOperation = 'destination-in';
				tctx.drawImage(mc,0,0);
				tctx.globalCompositeOperation = 'source-over';
			}catch(e){ console.warn('applyColorToLayer failed', e); }
			// keep color
			layer.color = color;
		}

		// wire layer color input to recolor selected layer
		if (layerColorInput) {
			let raf = null;
			layerColorInput.addEventListener('input', ()=>{
				const v = layerColorInput.value;
				if (raf) cancelAnimationFrame(raf);
				raf = requestAnimationFrame(()=>{
					if (selectedLayer >= 0 && layers[selectedLayer] && layers[selectedLayer].recolorable) {
						applyColorToLayer(layers[selectedLayer], v);
						draw();
					}
				});
			});
		}

		// 按区域分割填充：对 template 的 alpha 做连通域标记 (4-连通)，为每个区域生成独立填充图层
		addFillRegionsBtn.addEventListener('click', ()=>{
			if (!templateImg || !templateImg.complete) { alert('请先选择车型并加载模板'); return; }
			const tW = templateImg.width, tH = templateImg.height;
			const probe = document.createElement('canvas'); probe.width = tW; probe.height = tH; const pctx = probe.getContext('2d');
			try{
				pctx.drawImage(templateImg,0,0);
			}catch(e){ alert('无法读取模板像素（可能被 CORS 限制）'); return; }
			const imgData = pctx.getImageData(0,0,tW,tH);
			// binary original mask (use a threshold to ignore thin AA bridges)
			const alpha = new Uint8Array(tW*tH);
			let TH = 16; // alpha threshold (0-255). lower -> keep more; raise to disconnect very faint bridges
			try{
				const v = parseInt((regionThreshold && regionThreshold.value) || (regionThresholdNumber && regionThresholdNumber.value) || 16, 10);
				if (!Number.isFinite(v) || v < 0 || v > 255) throw new Error('invalid');
				TH = v;
			}catch(e){ TH = 16; }
			for (let i=0;i<tW*tH;i++) alpha[i] = (imgData.data[i*4 + 3] >= TH) ? 1 : 0;

			// 1) erosion (8-neighbor) to produce robust seeds that avoid thin bridges
			const eroded = new Uint8Array(tW*tH);
			for (let y=0;y<tH;y++){
				for (let x=0;x<tW;x++){
					const i = y*tW + x;
					if (!alpha[i]) { eroded[i]=0; continue; }
					let ok = 1;
					for (let oy=-1; oy<=1; oy++){
						for (let ox=-1; ox<=1; ox++){
							if (ox===0 && oy===0) continue;
							const nx = x+ox, ny = y+oy;
							if (nx<0||ny<0||nx>=tW||ny>=tH) { ok = 0; break; }
							if (!alpha[ny*tW + nx]) { ok = 0; break; }
						}
						if (!ok) break;
					}
					eroded[i] = ok ? 1 : 0;
				}
			}

			// 2) connected components on eroded image to generate seeds
			const seedLabel = new Int32Array(tW*tH);
			let seeds = 0;
			const sstack = [];
			for (let y=0;y<tH;y++){
				for (let x=0;x<tW;x++){
					const i = y*tW + x;
					if (!eroded[i] || seedLabel[i] !== 0) continue;
					seeds++;
					let lbl = seeds;
					// flood fill over eroded (4-connectivity is fine here)
					sstack.length = 0; sstack.push(i); seedLabel[i] = lbl;
					while(sstack.length){
						const cur = sstack.pop();
						const cx = cur % tW, cy = Math.floor(cur / tW);
						const neigh = [[cx,cy-1],[cx,cy+1],[cx-1,cy],[cx+1,cy]];
						for (let ni=0; ni<neigh.length; ni++){
							const nx = neigh[ni][0], ny = neigh[ni][1];
							if (nx<0||ny<0||nx>=tW||ny>=tH) continue;
							const nidx = ny*tW + nx;
							if (eroded[nidx] && seedLabel[nidx] === 0){ seedLabel[nidx] = lbl; sstack.push(nidx); }
						}
					}
				}
			}

			if (seeds === 0) {
				// fallback: single region covering whole mask
				if (!alpha.some(v=>v)) { alert('模板没有可填充区域'); return; }
				// create one region from full mask
				const col = hexToRgb(fillColorInput.value || '#ff0000');
				const regionCanvas = document.createElement('canvas'); regionCanvas.width = tW; regionCanvas.height = tH; const rCtx = regionCanvas.getContext('2d');
				const mask = rCtx.createImageData(tW,tH);
				for (let i=0;i<tW*tH;i++){
					mask.data[i*4+0] = col[0]; mask.data[i*4+1] = col[1]; mask.data[i*4+2] = col[2]; mask.data[i*4+3] = imgData.data[i*4+3];
				}
				rCtx.putImageData(mask,0,0);
				const id = layerIdCounter++; const img = new Image(); img.crossOrigin='anonymous'; img.width = tW; img.height = tH;
				const lay = { id, name: `Region ${id}`, img, maskCanvas: regionCanvas, recolorable:true, color: fillColorInput.value || '#ff0000', scale:1, rotate:0, opacity:1, x: tW/2, y: tH/2, visible:true };
				layers.push(lay); applyColorToLayer(lay, lay.color);
				selectedLayer = layers.length - 1; renderLayerList(); syncInputsFromLayer(); draw();
				return;
			}

			// 3) multi-source BFS over original alpha to partition original mask using seeds as sources
			const labelMap = new Int32Array(tW*tH); // 0 = unassigned
			// queue with head/tail
			const qIdx = new Int32Array(tW*tH);
			const qLabel = new Int32Array(tW*tH);
			let qHead = 0, qTail = 0;
			for (let i=0;i<tW*tH;i++){
				if (seedLabel[i] !== 0){ labelMap[i] = seedLabel[i]; qIdx[qTail] = i; qLabel[qTail] = seedLabel[i]; qTail++; }
			}
			// Also mark non-mask pixels as -1 to avoid expansion
			for (let i=0;i<tW*tH;i++) if (!alpha[i]) labelMap[i] = -1;
			// BFS expand into original alpha (4-neighbors)
			while(qHead < qTail){
				const cur = qIdx[qHead]; const lbl = qLabel[qHead]; qHead++;
				const cx = cur % tW, cy = Math.floor(cur / tW);
				const neigh = [[cx,cy-1],[cx,cy+1],[cx-1,cy],[cx+1,cy]];
				for (let ni=0; ni<neigh.length; ni++){
					const nx = neigh[ni][0], ny = neigh[ni][1];
					if (nx<0||ny<0||nx>=tW||ny>=tH) continue;
					const nidx = ny*tW + nx;
					if (alpha[nidx] && labelMap[nidx] === 0){ labelMap[nidx] = lbl; qIdx[qTail] = nidx; qLabel[qTail] = lbl; qTail++; }
				}
			}

			// 4) for each label, build region canvas using original alpha for smooth edges
			const colRGB = hexToRgb(fillColorInput.value || '#ff0000');
			const labelBboxes = new Map();
			for (let i=0;i<tW*tH;i++){
				const l = labelMap[i]; if (l <= 0) continue;
				const y = Math.floor(i / tW), x = i % tW;
				if (!labelBboxes.has(l)) labelBboxes.set(l, {minX:x, maxX:x, minY:y, maxY:y});
				else { const b = labelBboxes.get(l); if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x; if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y; }
			}
			// create layers for each label
			for (const [lbl, b] of labelBboxes.entries()){
				const minX = b.minX, minY = b.minY, rw = b.maxX - b.minX + 1, rh = b.maxY - b.minY + 1;
				const rOff = document.createElement('canvas'); rOff.width = rw; rOff.height = rh; const rCtx = rOff.getContext('2d');
				const mask = rCtx.createImageData(rw, rh);
				for (let yy=0; yy<rh; yy++){
					for (let xx=0; xx<rw; xx++){
						const gx = minX + xx, gy = minY + yy; const gi = gy * tW + gx;
						const m = (labelMap[gi] === lbl) ? imgData.data[gi*4 + 3] : 0;
						const offi = (yy*rw + xx) * 4;
						mask.data[offi + 0] = colRGB[0];
						mask.data[offi + 1] = colRGB[1];
						mask.data[offi + 2] = colRGB[2];
						mask.data[offi + 3] = m;
					}
				}
				rCtx.putImageData(mask,0,0);
				const id = layerIdCounter++;
				const img = new Image(); img.crossOrigin='anonymous'; img.width = rw; img.height = rh;
				const lay = { id, name: `Region ${id}`, img, maskCanvas: rOff, recolorable:true, color: fillColorInput.value || '#ff0000', scale:1, rotate:0, opacity:1, x: minX + rw/2, y: minY + rh/2, visible:true };
				layers.push(lay);
				applyColorToLayer(lay, lay.color);
			}
			if (layers.length) { selectedLayer = layers.length - 1; renderLayerList(); syncInputsFromLayer(); }
			// single draw after creating region layers to avoid repeated redraws
			draw();
		});
const exportSize = document.getElementById('exportSize');
exportBtn.addEventListener('click', ()=>{ const s = exportSize && exportSize.value ? exportSize.value : '1024'; exportAtSize(s); });

// build export PNG blob at requested size (returns Blob)
async function buildExportBlob(size){
	if (!(templateImg && templateImg.complete && templateImg.naturalWidth)) { throw new Error('模板未加载'); }
	const target = Math.max(1, parseInt(size,10) || 1024);
	const baseW = templateImg.width, baseH = templateImg.height;
	const off = document.createElement('canvas'); off.width = baseW; off.height = baseH; const offCtx = off.getContext('2d'); offCtx.clearRect(0,0,off.width,off.height);
	layers.forEach((lay)=>{
		if (!lay.visible) return;
		offCtx.save(); offCtx.globalAlpha = lay.opacity;
		const cx = (lay.x || baseW/2);
		const cy = (lay.y || baseH/2);
		offCtx.translate(cx, cy);
		offCtx.rotate((lay.rotate || 0) * Math.PI/180);
		const src = lay.rasterCanvas || lay.img;
		if (!src) { offCtx.restore(); return; }
		const w = ( (src.width || lay.img.width) * (lay.scale||1));
		const h = ( (src.height || lay.img.height) * (lay.scale||1));
		offCtx.drawImage(src, -w/2, -h/2, w, h);
		offCtx.restore();
	});
	try{ offCtx.globalCompositeOperation = 'destination-in'; offCtx.drawImage(templateImg,0,0); }catch(e){ offCtx.globalCompositeOperation = 'destination-in'; offCtx.drawImage(templateImg,0,0); }
	const out = document.createElement('canvas'); out.width = target; out.height = target; const outCtx = out.getContext('2d');
	const scale = Math.min(target / baseW, target / baseH);
	const dw = baseW * scale, dh = baseH * scale;
	const dx = (target - dw)/2, dy = (target - dh)/2;
	outCtx.fillStyle = '#0000'; outCtx.clearRect(0,0,target,target);
	outCtx.drawImage(off, 0, 0, baseW, baseH, dx, dy, dw, dh);
	const blob = await new Promise(res=>out.toBlob(res,'image/png'));
	return blob;
}

async function writeBlobToDirectory(blob, dirHandle, filename){
	const fh = await dirHandle.getFileHandle(filename, { create: true });
	const w = await fh.createWritable();
	await w.write(blob);
	await w.close();
}

async function quickExportToUsb(){
	const size = exportSize && exportSize.value ? exportSize.value : '1024';
	let blob;
	try{ blob = await buildExportBlob(size); }catch(e){ showToast('构建导出文件失败：' + (e && e.message), 'info'); return; }
	const suggestedName = makeSuggestedName(size);
	// Best-effort: prompt user to pick the USB root directory and write into /Wraps
	if (window.showDirectoryPicker) {
		try{
			// ask user to pick the drive root (instruct via prompt)
			const dir = await window.showDirectoryPicker();
			try{
				const wraps = await dir.getDirectoryHandle('Wraps', { create: true });
				await writeBlobToDirectory(blob, wraps, suggestedName);
				showToast('已保存到：Wraps/' + suggestedName, 'success');
				return;
			}catch(e){
				// cannot create Wraps dir, try writing directly
				try{ await writeBlobToDirectory(blob, dir, suggestedName); showToast('已保存到所选目录：' + suggestedName, 'success'); return; }catch(err){ console.warn('写入所选目录失败', err); }
			}
		}catch(e){
			// user cancelled or API error -> if user cancelled, stop and do not fallback to download
			console.log('showDirectoryPicker cancelled or failed', e);
			if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
				showToast('已取消导出', 'info');
				return;
			}
		}
	}

	// fallback: try showSaveFilePicker if available
	if (window.showSaveFilePicker) {
		try{
			const opts = { suggestedName, types: [{ description: 'PNG Image', accept: {'image/png':['.png']} }] };
			const handle = await window.showSaveFilePicker(opts);
			const writable = await handle.createWritable();
			await writable.write(blob);
			await writable.close();
			alert('已保存到所选位置：' + suggestedName);
			return;
	}catch(e){
			console.log('showSaveFilePicker cancelled or failed', e);
			if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
				showToast('已取消导出', 'info');
				return;
			}
		}
	}

	// last resort: trigger download
	try{
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a'); a.href = url; a.download = suggestedName; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
		showToast('已通过浏览器下载保存（请在浏览器下载目录中查看）', 'info');
	}catch(e){ showToast('导出失败：' + (e && e.message), 'info'); }
}

if (quickExportUsb) quickExportUsb.addEventListener('click', ()=>{ quickExportToUsb(); });

if (fitBtn) fitBtn.addEventListener('click', fitSelectedToTemplate);
	resetBtn.addEventListener('click', resetAll);
		bringFront.addEventListener('click', function(){
			if (selectedLayer >= 0) {
				const lay = layers.splice(selectedLayer, 1)[0];
				layers.push(lay);
				selectedLayer = layers.length - 1;
				renderLayerList();
				draw();
			}
		});

		removeWrap.addEventListener('click', function(){
			if (selectedLayer >= 0) {
				layers.splice(selectedLayer, 1);
				selectedLayer = Math.min(selectedLayer, layers.length - 1);
				renderLayerList();
				draw();
			}
		});

// load models.json
fetch('models.json').then(r=>r.json()).then(data=>{
	models = data;
	populateModelSelect();
}).catch(err=>{
	console.error('无法加载 models.json', err);
	// fallback: minimal hardcoded
});

function populateModelSelect(){
	Object.keys(models).forEach(key=>{
		const opt = document.createElement('option'); opt.value = key; opt.textContent = key; modelSelect.appendChild(opt);
	});
	modelSelect.addEventListener('change', ()=>attemptLoadModel(modelSelect.value));
	if (modelSelect.options.length) { modelSelect.selectedIndex = 0; loadModel(modelSelect.value); }
}

	function attemptLoadModel(key){
		// if there are layers, warn user that switching will clear them
		if (layers && layers.length > 0) {
			const ok = confirm('当前工程包含图层，切换车型会清空这些图层，是否继续？');
			if (!ok) {
				// restore previous selection
				for (let i=0;i<modelSelect.options.length;i++){ if (modelSelect.options[i].value === currentModelKey) { modelSelect.selectedIndex = i; break; } }
				return;
			}
			// user confirmed -> clear layers
			layers = []; selectedLayer = -1; renderLayerList();
		}
		loadModel(key);
	}

	function loadModel(key){
	currentModelKey = key;
		// reset editor state when loading a new model
		resetAll();
		try{ if (uploadName) uploadName.textContent = ''; }catch(e){}
		if (layerColorInput) { layerColorInput.disabled = true; layerColorInput.value = '#ff0000'; }
	const m = models[key];
	if (!m) return;
	templateImg = new Image(); templateImg.src = m.template;
	vehicleImg = new Image(); vehicleImg.src = m.vehicle_image; vehiclePreview.src = m.vehicle_image;
	// when template loaded, redraw and adjust canvas size to template ratio
	templateImg.onload = ()=>{
		// adjust canvas to layout and redraw
		adjustCanvasForLayout();
		draw();
	}

			// build thumbs (if examples exist) or let user upload
			thumbs.innerHTML = '';
			if (m.examples && m.examples.length) {
					m.examples.forEach(p=>{
						const im = document.createElement('img'); im.src = p; im.className='thumb';
						im.title = p.split('/').pop();
						im.addEventListener('click', ()=>{ addLayerFromUrl(p); });
						thumbs.appendChild(im);
					});
			} else {
				// show placeholder text
				// const p = document.createElement('div'); p.style.color='#666'; p.style.fontSize='13px'; p.textContent='该车型没有内置示例。请上传本地贴膜图片以用于预览。';
				// thumbs.appendChild(p);
			}


}

		function addUploadedLayer(file) {
			if (!file) { alert('请选择图片文件'); return; }
			const url = URL.createObjectURL(file);
			const img = new Image(); img.src = url; img.crossOrigin = 'anonymous';
			const id = layerIdCounter++;
			const lay = {id, name: 'Layer ' + id, img, scale:1, rotate:0, opacity:1, x: templateImg.width/2 || 0, y: templateImg.height/2 || 0, visible:true};
			layers.push(lay); selectedLayer = layers.length - 1; renderLayerList(); syncInputsFromLayer();
			img.onload = ()=>{ fitSelectedToTemplate(); renderLayerList(); draw(); syncInputsFromLayer(); }
			// clear file input so same file can be selected again
			try{ if (uploadInput) { uploadInput.value = ''; } if (uploadName) uploadName.textContent = ''; }catch(e){}
		}

			function addLayerFromUrl(url){
				const img = new Image(); img.crossOrigin='anonymous'; img.src = url;
				const id = layerIdCounter++;
				const lay = {id, name: 'Layer ' + id, img, scale:1, rotate:0, opacity:1, x: templateImg.width/2 || 0, y: templateImg.height/2 || 0, visible:true};
				layers.push(lay); selectedLayer = layers.length - 1; renderLayerList(); syncInputsFromLayer();
				img.onload = ()=>{ fitSelectedToTemplate(); renderLayerList(); draw(); syncInputsFromLayer(); }
			}

		function renderLayerList(){
			const container = document.getElementById('layers'); container.innerHTML = '';
			layers.forEach((lay, idx)=>{
				const el = document.createElement('div'); el.style.display='flex'; el.style.alignItems='center'; el.style.gap='8px';
				el.style.border = (idx===selectedLayer) ? '1px solid #0366d6' : '1px solid #e6eef9'; el.style.padding='6px'; el.style.borderRadius='8px';
				// hidden layers show a light yellow background; selected layer keeps its highlight
				let bg = '#fff';
				if (!lay.visible) bg = '#fffbe6';
				if (idx === selectedLayer) bg = '#eef6ff';
				el.style.background = bg; el.style.cursor='pointer';
				// smooth transitions for background/transform when selecting/deselecting
				el.style.transition = 'background-color 220ms ease, transform 160ms ease, opacity 160ms ease';

				// color swatch
				const sw = document.createElement('div'); sw.className = 'color-swatch';
				if (lay.recolorable) sw.classList.add('recolorable'); else sw.classList.add('disabled');
				if (lay.color) sw.style.background = lay.color;
				else if (lay.rasterCanvas){ try{ sw.style.background = 'url(' + lay.rasterCanvas.toDataURL() + ') center/cover no-repeat'; }catch(e){ sw.style.background = 'linear-gradient(45deg,#f3f6fb,#fff)'; } }
				sw.title = lay.recolorable ? '可重着色：点击选择' : '不可重着色';

				// name and controls
				const nameWrap = document.createElement('div'); nameWrap.style.flex='1'; nameWrap.style.minWidth='0';
				const nameInput = document.createElement('input'); nameInput.type='text'; nameInput.value = lay.name || ('Layer ' + lay.id);
				nameInput.style.width = '100%'; nameInput.style.border='none'; nameInput.style.background='transparent'; nameInput.readOnly = (idx !== selectedLayer);
				if (!nameInput.readOnly) { nameInput.style.borderBottom = '1px dashed #0366d6'; } else { nameInput.style.borderBottom='none'; }
				nameInput.style.cursor = 'pointer';
				nameInput.onclick = ()=>{ selectedLayer = idx; renderLayerList(); draw(); syncInputsFromLayer(); };
				nameInput.onchange = ()=>{ lay.name = nameInput.value; renderLayerList(); };
				if (idx === selectedLayer) { nameInput.readOnly = false; setTimeout(()=>{ try{ nameInput.focus(); nameInput.select(); }catch{} }, 10); }

				function updateGlobalButtons(){
					const can = selectedLayer >= 0 && layers[selectedLayer];
					bringFront.disabled = !can;
					removeWrap.disabled = !can;
					// layerColor enabled only for recolorable layers
					if (layerColorInput) {
						if (can && layers[selectedLayer].recolorable) {
							layerColorInput.disabled = false; layerColorInput.value = layers[selectedLayer].color || '#ff0000';
							layerColorInput.classList.remove('disabled'); layerColorInput.classList.add('enabled');
						}
						else {
							layerColorInput.disabled = true; layerColorInput.classList.remove('enabled'); layerColorInput.classList.add('disabled');
						}
					}
				}

				// controls
				const up = document.createElement('button'); up.textContent='↑'; up.className='small'; up.onclick = (ev)=>{ ev.stopPropagation(); if (idx<=0) return; const a=layers[idx-1]; layers[idx-1]=layers[idx]; layers[idx]=a; selectedLayer = idx-1; renderLayerList(); draw(); };
				const down = document.createElement('button'); down.textContent='↓'; down.className='small'; down.onclick = (ev)=>{ ev.stopPropagation(); if (idx>=layers.length-1) return; const a=layers[idx+1]; layers[idx+1]=layers[idx]; layers[idx]=a; selectedLayer = idx+1; renderLayerList(); draw(); };
				const hide = document.createElement('button'); hide.textContent = lay.visible? '隐藏':'显示'; hide.className='small'; hide.onclick = (ev)=>{ ev.stopPropagation(); lay.visible = !lay.visible; renderLayerList(); draw(); };
				const del = document.createElement('button'); del.textContent='删除'; del.className='small'; del.onclick = (ev)=>{ ev.stopPropagation(); layers.splice(idx,1); if (selectedLayer>=layers.length) selectedLayer = layers.length-1; renderLayerList(); draw(); };

				nameWrap.appendChild(nameInput);

				// assemble
				el.appendChild(sw);
				const thumb = document.createElement('div'); thumb.className = 'layer-thumb'; if (lay.thumbData) thumb.style.backgroundImage = `url(${lay.thumbData})`; el.appendChild(thumb);
				el.appendChild(nameWrap);
				el.appendChild(up); el.appendChild(down); el.appendChild(hide); el.appendChild(del);

				// wire events
				sw.addEventListener('click', (ev)=>{ ev.stopPropagation(); if (lay.recolorable){ selectedLayer = idx; updateGlobalButtons(); renderLayerList(); draw(); syncInputsFromLayer(); } });
				el.addEventListener('click', (ev)=>{
					const tag = ev.target.tagName.toLowerCase(); if (tag === 'button' || tag === 'input') return; // let button/input handle their own events
					if (selectedLayer === idx) {
						// animate deselect: shrink slightly and fade background to base color
						el.style.transform = 'scale(0.98)';
						const targetBg = lay.visible ? '#fff' : '#fffbe6';
						el.style.background = targetBg;
						setTimeout(()=>{
							selectedLayer = -1;
							// reset controls to defaults
							scaleInput.value = 1; scaleNumber.value = 1;
							rotateInput.value = 0; rotateNumber.value = 0;
							opacityInput.value = 1; opacityNumber.value = 1;
							posXInput.value = 0; posYInput.value = 0;
							renderLayerList(); draw();
						}, 220);
						return;
					}
					selectedLayer = idx;
					renderLayerList();
					draw();
					syncInputsFromLayer();
				});

				// ensure initial state
				updateGlobalButtons();

				container.appendChild(el);
			});
		}

// initial layout and draw
adjustCanvasForLayout();
draw();

		// sync threshold controls
		if (regionThreshold && regionThresholdNumber){
			regionThreshold.addEventListener('input', ()=>{ regionThresholdNumber.value = regionThreshold.value; });
			regionThresholdNumber.addEventListener('input', ()=>{
				let v = parseInt(regionThresholdNumber.value||0,10); if (isNaN(v)) v = 16; v = Math.max(0, Math.min(255, v)); regionThresholdNumber.value = v; regionThreshold.value = v;
			});
		}

			// canvas interactions for layers: drag to move; handles for scale/rotate
			let pointerState = { mode: null, startX:0, startY:0, startVal: null }; // mode: 'move'|'scale'|'rotate'|'none'

			function getTemplateTransform(){
				const dpr = window.devicePixelRatio || 1;
				const cssW = canvas.width / dpr; const cssH = canvas.height / dpr;
				const scale = Math.min(cssW / templateImg.width, cssH / templateImg.height);
				const drawW = templateImg.width * scale; const drawH = templateImg.height * scale;
				const offsetX = (cssW - drawW)/2; const offsetY = (cssH - drawH)/2;
				return {scale, drawW, drawH, offsetX, offsetY};
			}

			// return topmost layer index at canvas coords (or -1)
			function layerAtCanvasPoint(canvasX, canvasY){
				if (!templateImg || !templateImg.complete) return -1;
				const t = getTemplateTransform();
				const tx = (canvasX - t.offsetX) / t.scale;
				const ty = (canvasY - t.offsetY) / t.scale;
				// iterate top-down
				for (let i = layers.length - 1; i >= 0; i--){
					const lay = layers[i];
					if (!lay || !lay.visible) continue;
					// choose source for pixel test: prefer maskCanvas, then rasterCanvas, then lay.img
					const src = (lay.maskCanvas || lay.rasterCanvas || lay.img);
					if (!src) continue;
					// determine source size
					const srcW = (src.width || (lay.img && lay.img.width) || 0);
					const srcH = (src.height || (lay.img && lay.img.height) || 0);
					if (!srcW || !srcH) continue;
					const scaledW = srcW * (lay.scale||1);
					const scaledH = srcH * (lay.scale||1);
					// local coords relative to layer center
					const dx = tx - (lay.x || 0);
					const dy = ty - (lay.y || 0);
					const ang = -(lay.rotate || 0) * Math.PI/180; // inverse rotate
					const rx = dx * Math.cos(ang) - dy * Math.sin(ang);
					const ry = dx * Math.sin(ang) + dy * Math.cos(ang);
					// quick bounding-box reject
					if (rx < -scaledW/2 || rx > scaledW/2 || ry < -scaledH/2 || ry > scaledH/2) continue;
					// map rx,ry to source pixel coordinates
					const localX = rx + scaledW/2; // 0..scaledW
					const localY = ry + scaledH/2; // 0..scaledH
					const u = localX / scaledW;
					const v = localY / scaledH;
					let sx = Math.floor(u * srcW);
					let sy = Math.floor(v * srcH);
					// clamp
					sx = Math.max(0, Math.min(srcW-1, sx)); sy = Math.max(0, Math.min(srcH-1, sy));
					// try to sample a single pixel from source
					let hit = false;
					try{
						pixelProbeCtx.clearRect(0,0,1,1);
						// draw source pixel into 1x1 probe
						if (src === lay.img) {
							// draw the image region corresponding to sx,sy (source coords) into probe
							pixelProbeCtx.drawImage(src, sx, sy, 1, 1, 0, 0, 1, 1);
						} else {
							// canvas-like source supports direct draw
							pixelProbeCtx.drawImage(src, sx, sy, 1, 1, 0, 0, 1, 1);
						}
						const d = pixelProbeCtx.getImageData(0,0,1,1).data;
						if (d[3] > 10) hit = true; // non-transparent
					}catch(e){
						// if sampling fails (likely CORS), fall back to bounding-box selection
						return i;
					}
					if (hit) return i;
				}
				return -1;
			}

		function renderSelectionHandles(){
			if (selectedLayer<0 || !layers[selectedLayer] || !layers[selectedLayer].img.complete) return;
			const lay = layers[selectedLayer];
			const t = getTemplateTransform();
			const cx = t.offsetX + (lay.x||0) * t.scale; const cy = t.offsetY + (lay.y||0) * t.scale;
			const w = (lay.img.width * (lay.scale||1)) * t.scale; const h = (lay.img.height * (lay.scale||1)) * t.scale;
			// draw rect
			ctx.save(); ctx.strokeStyle='#0366d6'; ctx.lineWidth=2; ctx.strokeRect(cx - w/2, cy - h/2, w, h);
			// draw handles at corners (slightly larger for high-DPI)
			const hs = 10; const corners = [[-w/2,-h/2],[w/2,-h/2],[w/2,h/2],[-w/2,h/2]];
			ctx.fillStyle='#fff'; ctx.strokeStyle='#0366d6';
			corners.forEach(c=>{ ctx.beginPath(); ctx.rect(cx + c[0]-hs/2, cy + c[1]-hs/2, hs, hs); ctx.fill(); ctx.stroke(); });
			// draw rotate handle above top-center (bigger radius)
			ctx.beginPath(); ctx.arc(cx, cy - h/2 - 20, 10, 0, Math.PI*2); ctx.fill(); ctx.stroke();
			ctx.restore();
		}

				function canvasPointFromEvent(e){
					const r = canvas.getBoundingClientRect();
					return { x: e.clientX - r.left, y: e.clientY - r.top };
				}

			canvas.addEventListener('pointerdown', e=>{
					const pt = canvasPointFromEvent(e); const x = pt.x, y = pt.y;
					// hit test: select topmost layer under cursor
					const hit = layerAtCanvasPoint(x, y);
					if (hit === -1) {
						// clicked empty canvas: deselect any selected layer and reset controls
						selectedLayer = -1;
						scaleInput.value = 1; scaleNumber.value = 1;
						rotateInput.value = 0; rotateNumber.value = 0;
						opacityInput.value = 1; opacityNumber.value = 1;
						posXInput.value = 0; posYInput.value = 0;
						renderLayerList(); draw();
						return;
					}
					if (hit !== -1 && hit !== selectedLayer) {
						selectedLayer = hit; renderLayerList(); draw(); syncInputsFromLayer();
					}
					if (selectedLayer<0 || !layers[selectedLayer] || !layers[selectedLayer].img.complete) return;
				const t = getTemplateTransform();
				const lay = layers[selectedLayer];
				const cx = t.offsetX + (lay.x||0) * t.scale; const cy = t.offsetY + (lay.y||0) * t.scale;
				const w = (lay.img.width * (lay.scale||1)) * t.scale; const h = (lay.img.height * (lay.scale||1)) * t.scale;
				// check handles
				const hs = 8; const corners = [{dx:-w/2,dy:-h/2},{dx:w/2,dy:-h/2},{dx:w/2,dy:h/2},{dx:-w/2,dy:h/2}];
				for (let i=0;i<corners.length;i++){
					const hx = cx + corners[i].dx, hy = cy + corners[i].dy;
					if (x >= hx-hs && x <= hx+hs && y >= hy-hs && y <= hy+hs){
						pointerState.mode = 'scale'; pointerState.startX = x; pointerState.startY = y; pointerState.startVal = {scale: lay.scale}; canvas.setPointerCapture(e.pointerId); return;
					}
				}
				// rotate handle
					const rx = cx, ry = cy - h/2 - 20;
					const dist = Math.hypot(x-rx, y-ry);
					if (HIT_DEBUG) console.log('rotate-hit-test', {x, y, rx, ry, dist, layIndex: selectedLayer});
					if (dist <= 20){ pointerState.mode='rotate'; pointerState.startX=x; pointerState.startY=y; pointerState.startVal={rotate:lay.rotate}; canvas.setPointerCapture(e.pointerId); return; }
						// otherwise start move
						pointerState.mode='move'; pointerState.startX = x; pointerState.startY = y; pointerState.startVal = {x:lay.x, y:lay.y}; canvas.setPointerCapture(e.pointerId);
			});

			canvas.addEventListener('pointermove', e=>{
				if (!pointerState.mode || selectedLayer<0) return;
				const lay = layers[selectedLayer]; if (!lay) return;
				const t = getTemplateTransform(); const pt = canvasPointFromEvent(e); const x = pt.x, y = pt.y;
					if (pointerState.mode === 'move'){
						const dx = (x - pointerState.startX) / t.scale; const dy = (y - pointerState.startY) / t.scale;
						lay.x = Math.max(0, Math.min(templateImg.width, pointerState.startVal.x + dx));
						lay.y = Math.max(0, Math.min(templateImg.height, pointerState.startVal.y + dy));
						draw();
						syncInputsFromLayer();
					} else if (pointerState.mode === 'scale'){
						// scale by vertical movement
						const delta = (x - pointerState.startX + y - pointerState.startY) * 0.005;
						lay.scale = Math.max(0.05, pointerState.startVal.scale + delta);
						scaleInput.value = lay.scale; scaleNumber.value = lay.scale; draw();
						syncInputsFromLayer();
					} else if (pointerState.mode === 'rotate'){
						const cx = t.offsetX + (lay.x||0)*t.scale; const cy = t.offsetY + (lay.y||0)*t.scale;
						const a1 = Math.atan2(pointerState.startY - cy, pointerState.startX - cx);
						const a2 = Math.atan2(y - cy, x - cx);
						const deg = (a2 - a1) * 180 / Math.PI;
						lay.rotate = (pointerState.startVal.rotate || 0) + deg; rotateInput.value = lay.rotate; rotateNumber.value = lay.rotate; draw();
						syncInputsFromLayer();
					}
			});

			canvas.addEventListener('pointerup', e=>{ pointerState.mode = null; try{ canvas.releasePointerCapture(e.pointerId);}catch{}; syncInputsFromLayer(); });

// frontend/js/template-editor.js
// Visual WhatsApp Message Template Editor for Admin Dashboard
// Uses: api(), toast(), _esc() from admin page globals
// DOM targets: #template-editor-container, #te-builder, #te-preview

(function () {
'use strict';

/* ─── STATE ──────────────────────────────────────────────────────── */
var _teMetaId = null;
var _teWabaId = null;
var _teData   = blankData();

var VARIABLE_SOURCES = [
  'customer.name','customer.wa_phone','order.order_number','order.total_rs',
  'order.items_summary','order.item_count','order.eta_text','order.status',
  'order.cancellation_reason','order.refund_amount_rs','order.tracking_url',
  'branch.name','restaurant.business_name','rider.name','rider.phone',
  'delivery_otp','item_count','cart_total'
];

var CATEGORIES = ['MARKETING','UTILITY','AUTHENTICATION'];
var LANGUAGES  = [
  {v:'en',l:'English'},{v:'hi',l:'Hindi'},{v:'te',l:'Telugu'},{v:'ta',l:'Tamil'},
  {v:'kn',l:'Kannada'},{v:'ml',l:'Malayalam'},{v:'bn',l:'Bengali'},{v:'mr',l:'Marathi'},
  {v:'gu',l:'Gujarati'},{v:'pa',l:'Punjabi'},{v:'ur',l:'Urdu'}
];

/* ─── HELPERS ────────────────────────────────────────────────────── */
function $(id){ return document.getElementById(id); }
function esc(s){ return typeof _esc==='function'? _esc(String(s||'')) : String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function blankData(){
  return { name:'', category:'MARKETING', language:'en',
    header:{type:'none',text:'',url:''},
    body:{text:''},
    footer:{text:''},
    buttons:[], variables:[] };
}

function slugify(s){
  return s.toLowerCase().replace(/[^a-z0-9_]/g,'_').replace(/_+/g,'_').replace(/^_|_$/g,'');
}

function fmtWa(s){
  return esc(s).replace(/\*([^*]+)\*/g,'<b>$1</b>')
    .replace(/_([^_]+)_/g,'<i>$1</i>')
    .replace(/~([^~]+)~/g,'<s>$1</s>')
    .replace(/\n/g,'<br>');
}

/* ─── OPEN / CLOSE ───────────────────────────────────────────────── */
window.openTemplateEditor = async function(metaId){
  _teMetaId = metaId || null;
  _teData   = blankData();

  if (_teMetaId) {
    try {
      var list = await api('/api/admin/templates');
      var arr  = list.templates || list.data || list || [];
      var tpl  = arr.find(function(t){ return t.id === _teMetaId || t.meta_id === _teMetaId; });
      if (tpl) parseTemplateInto(tpl);
    } catch(e){ toast('Failed to load template: '+e.message,'err'); }
  }

  var main = $('templates-content') || $('tab-templates');
  if (main) main.style.display = 'none';
  $('template-editor-container').style.display = '';
  teRender();
};

window.closeTemplateEditor = function(){
  $('template-editor-container').style.display = 'none';
  var main = $('templates-content') || $('tab-templates');
  if (main) main.style.display = '';
};

/* ─── GALLERY LOAD ───────────────────────────────────────────────── */
window.teLoadFromGallery = async function(templateId){
  try {
    var list = await api('/api/admin/templates/gallery');
    var arr  = list.templates || list.data || list || [];
    var tpl  = arr.find(function(t){ return t.id === templateId; });
    if (!tpl) { toast('Gallery template not found','err'); return; }
    parseTemplateInto(tpl);
    _teMetaId = null; // new template based on gallery
    teRender();
    toast('Template loaded from gallery','ok');
  } catch(e){ toast('Gallery load failed: '+e.message,'err'); }
};

function parseTemplateInto(tpl){
  _teData.name     = tpl.name || '';
  _teData.category = tpl.category || 'MARKETING';
  _teData.language = tpl.language || 'en';
  _teData.buttons  = [];
  _teData.variables = [];
  _teData.header = {type:'none',text:'',url:''};
  _teData.body   = {text:''};
  _teData.footer = {text:''};

  var comps = tpl.components || [];
  comps.forEach(function(c){
    if (c.type==='HEADER'){
      _teData.header.type = c.format || 'TEXT';
      if (c.format==='TEXT') _teData.header.text = c.text || '';
      else if (c.example && c.example.header_handle) _teData.header.url = c.example.header_handle[0] || '';
    }
    if (c.type==='BODY'){
      _teData.body.text = c.text || '';
      if (c.example && c.example.body_text && c.example.body_text[0]){
        c.example.body_text[0].forEach(function(s,i){
          _teData.variables.push({index:i+1, source:'', sample:s});
        });
      }
    }
    if (c.type==='FOOTER') _teData.footer.text = c.text || '';
    if (c.type==='BUTTONS' && c.buttons){
      _teData.buttons = c.buttons.map(function(b){
        return {type:b.type||'QUICK_REPLY', text:b.text||'', value:b.url||b.phone_number||''};
      });
    }
  });

  // extract variables from body if not already set
  var m = (_teData.body.text || '').match(/\{\{\d+\}\}/g);
  if (m && !_teData.variables.length){
    m.forEach(function(v,i){
      _teData.variables.push({index:i+1, source:'', sample:''});
    });
  }
}

/* ─── RENDER ─────────────────────────────────────────────────────── */
window.teRender = function(){
  renderBuilder();
  renderPreview();
};

function renderBuilder(){
  var d = _teData;
  var h = '';

  // Name
  h += '<label class="te-label">Template Name</label>';
  h += '<input class="te-input" id="te-name" value="'+esc(d.name)+'" placeholder="e.g. order_confirmation" onblur="teUpdateField(\'name\',this.value)">';

  // Category
  h += '<label class="te-label">Category</label><select class="te-input" onchange="teUpdateField(\'category\',this.value)">';
  CATEGORIES.forEach(function(c){
    h += '<option value="'+c+'"'+(d.category===c?' selected':'')+'>'+c+'</option>';
  });
  h += '</select>';

  // Language
  h += '<label class="te-label">Language</label><select class="te-input" onchange="teUpdateField(\'language\',this.value)">';
  LANGUAGES.forEach(function(l){
    h += '<option value="'+l.v+'"'+(d.language===l.v?' selected':'')+'>'+esc(l.l)+'</option>';
  });
  h += '</select>';

  // Header
  h += '<div class="te-section"><b>HEADER</b>';
  h += ' <select class="te-input te-inline" onchange="teSetHeaderType(this.value)">';
  ['none','TEXT','IMAGE','VIDEO','DOCUMENT'].forEach(function(t){
    h += '<option value="'+t+'"'+(d.header.type===t?' selected':'')+'>'+( t==='none'?'None':t)+'</option>';
  });
  h += '</select>';
  if (d.header.type==='TEXT'){
    h += '<input class="te-input" value="'+esc(d.header.text)+'" placeholder="Header text" oninput="teUpdateField(\'header.text\',this.value)">';
  } else if (d.header.type!=='none'){
    h += '<input class="te-input" value="'+esc(d.header.url)+'" placeholder="Media URL" oninput="teUpdateField(\'header.url\',this.value)">';
  }
  h += '</div>';

  // Body
  var bodyLen = (d.body.text||'').length;
  h += '<div class="te-section"><b>BODY</b> <span class="te-dim">'+bodyLen+'/1024</span>';
  h += ' <button class="te-btn-sm" onclick="teInsertVariable()">+ Variable</button>';
  h += '<textarea class="te-input te-body" id="te-body-ta" maxlength="1024" oninput="teUpdateField(\'body.text\',this.value)">'+esc(d.body.text)+'</textarea>';
  h += '</div>';

  // Footer
  var footOn = !!d.footer.text;
  h += '<div class="te-section"><b>FOOTER</b>';
  h += ' <label><input type="checkbox" id="te-foot-chk" '+(footOn?'checked':'')+' onchange="if(!this.checked){teUpdateField(\'footer.text\',\'\')}"> Enable</label>';
  if (footOn || $('te-foot-chk')&&$('te-foot-chk').checked){
    h += '<input class="te-input" value="'+esc(d.footer.text)+'" maxlength="60" placeholder="Footer text (60 chars)" oninput="teUpdateField(\'footer.text\',this.value)">';
    h += ' <span class="te-dim">'+(d.footer.text||'').length+'/60</span>';
  }
  h += '</div>';

  // Buttons
  h += '<div class="te-section"><b>BUTTONS</b>';
  h += ' <button class="te-btn-sm" onclick="teAddButton()" '+(d.buttons.length>=3?'disabled':'')+'>+ Button</button>';
  d.buttons.forEach(function(b,i){
    h += '<div class="te-btn-row">';
    h += '<select class="te-input te-inline" onchange="teUpdateField(\'btn.'+i+'.type\',this.value)">';
    ['QUICK_REPLY','URL','PHONE_NUMBER'].forEach(function(t){
      h += '<option value="'+t+'"'+(b.type===t?' selected':'')+'>'+t.replace('_',' ')+'</option>';
    });
    h += '</select>';
    h += '<input class="te-input te-inline" value="'+esc(b.text)+'" placeholder="Label" oninput="teUpdateField(\'btn.'+i+'.text\',this.value)">';
    if (b.type!=='QUICK_REPLY'){
      h += '<input class="te-input te-inline" value="'+esc(b.value)+'" placeholder="'+(b.type==='URL'?'https://...':'Phone')+'" oninput="teUpdateField(\'btn.'+i+'.value\',this.value)">';
    }
    h += '<button class="te-btn-sm te-danger" onclick="teRemoveButton('+i+')">✕</button></div>';
  });
  h += '</div>';

  // Variables
  if (d.variables.length){
    h += '<div class="te-section"><b>VARIABLES</b>';
    h += '<table class="te-var-table"><tr><th>Var</th><th>Source</th><th>Sample</th></tr>';
    d.variables.forEach(function(v,i){
      h += '<tr><td>{{'+v.index+'}}</td><td><select class="te-input te-inline" onchange="teUpdateVariable('+i+',\'source\',this.value)">';
      h += '<option value="">-- select --</option>';
      VARIABLE_SOURCES.forEach(function(s){
        h += '<option value="'+s+'"'+(v.source===s?' selected':'')+'>'+s+'</option>';
      });
      h += '</select></td><td><input class="te-input te-inline" value="'+esc(v.sample)+'" placeholder="Sample" oninput="teUpdateVariable('+i+',\'sample\',this.value)"></td></tr>';
    });
    h += '</table></div>';
  }

  // Action buttons
  h += '<div class="te-actions">';
  h += '<button class="te-btn te-primary" onclick="teSaveTemplate()">Save Template</button>';
  if (_teMetaId){
    h += '<button class="te-btn te-danger" onclick="teDeleteTemplate()">Delete</button>';
  }
  h += '<button class="te-btn" onclick="closeTemplateEditor()">Cancel</button>';
  h += '</div>';

  $('te-builder').innerHTML = h;
}

function renderPreview(){
  var d = _teData;
  var h = '<div class="te-wa-bubble">';

  // Header
  if (d.header.type==='TEXT' && d.header.text){
    h += '<div class="te-wa-header"><b>'+fmtWa(d.header.text)+'</b></div>';
  } else if (d.header.type==='IMAGE'){
    h += '<div class="te-wa-img">'+(d.header.url?'<img src="'+esc(d.header.url)+'" alt="header">':'<div class="te-wa-img-ph">IMAGE</div>')+'</div>';
  } else if (d.header.type==='VIDEO'){
    h += '<div class="te-wa-img"><div class="te-wa-img-ph">VIDEO</div></div>';
  } else if (d.header.type==='DOCUMENT'){
    h += '<div class="te-wa-img"><div class="te-wa-img-ph">DOCUMENT</div></div>';
  }

  // Body
  if (d.body.text){
    var body = d.body.text;
    d.variables.forEach(function(v){
      var display = v.sample || (v.source ? '['+v.source+']' : '{{'+v.index+'}}');
      body = body.replace('{{'+v.index+'}}', display);
    });
    h += '<div class="te-wa-body">'+fmtWa(body)+'</div>';
  }

  // Footer
  if (d.footer.text){
    h += '<div class="te-wa-footer">'+esc(d.footer.text)+'</div>';
  }

  // Timestamp
  h += '<div class="te-wa-time">12:30 <span class="te-wa-checks">✓✓</span></div>';
  h += '</div>'; // end bubble

  // Buttons
  if (d.buttons.length){
    d.buttons.forEach(function(b){
      h += '<div class="te-wa-btn">'+esc(b.text||'Button')+'</div>';
    });
  }

  $('te-preview').innerHTML = h;
}

/* ─── FIELD UPDATES ──────────────────────────────────────────────── */
window.teUpdateField = function(field, value){
  if (field==='name'){ _teData.name = slugify(value); }
  else if (field==='category'){ _teData.category = value; }
  else if (field==='language'){ _teData.language = value; }
  else if (field==='header.text'){ _teData.header.text = value; renderPreview(); return; }
  else if (field==='header.url'){ _teData.header.url = value; renderPreview(); return; }
  else if (field==='body.text'){ _teData.body.text = value; renderPreview(); return; }
  else if (field==='footer.text'){ _teData.footer.text = value; renderPreview(); return; }
  else if (field.startsWith('btn.')){
    var parts = field.split('.');
    var idx = parseInt(parts[1]);
    var prop = parts[2];
    if (_teData.buttons[idx]) _teData.buttons[idx][prop] = value;
    if (prop==='type') teRender();
    else { renderPreview(); return; }
    return;
  }
  teRender();
};

window.teSetHeaderType = function(type){
  _teData.header.type = type;
  _teData.header.text = '';
  _teData.header.url  = '';
  teRender();
};

window.teAddButton = function(){
  if (_teData.buttons.length >= 3) return;
  _teData.buttons.push({type:'QUICK_REPLY', text:'', value:''});
  teRender();
};

window.teRemoveButton = function(idx){
  _teData.buttons.splice(idx,1);
  teRender();
};

/* ─── VARIABLES ──────────────────────────────────────────────────── */
window.teInsertVariable = function(){
  var nextIdx = _teData.variables.length + 1;
  var tag     = '{{'+nextIdx+'}}';
  var ta      = $('te-body-ta');

  if (ta){
    var start = ta.selectionStart;
    var end   = ta.selectionEnd;
    var txt   = _teData.body.text;
    _teData.body.text = txt.substring(0,start) + tag + txt.substring(end);
  } else {
    _teData.body.text += tag;
  }

  _teData.variables.push({index:nextIdx, source:'', sample:''});
  teRender();

  // restore cursor
  var ta2 = $('te-body-ta');
  if (ta2){ var pos = (ta?start:_teData.body.text.length-tag.length) + tag.length; ta2.focus(); ta2.setSelectionRange(pos,pos); }
};

window.teUpdateVariable = function(idx, field, value){
  if (_teData.variables[idx]){
    _teData.variables[idx][field] = value;
    renderPreview();
  }
};

/* ─── BUILD META COMPONENTS ──────────────────────────────────────── */
function buildComponents(){
  var d = _teData;
  var comps = [];

  // Header
  if (d.header.type !== 'none'){
    if (d.header.type === 'TEXT'){
      comps.push({type:'HEADER', format:'TEXT', text:d.header.text});
    } else {
      var hdr = {type:'HEADER', format:d.header.type};
      if (d.header.url) hdr.example = {header_handle:[d.header.url]};
      comps.push(hdr);
    }
  }

  // Body
  if (d.body.text){
    var bc = {type:'BODY', text:d.body.text};
    if (d.variables.length){
      bc.example = {body_text:[d.variables.map(function(v){ return v.sample||''; })]};
    }
    comps.push(bc);
  }

  // Footer
  if (d.footer.text){
    comps.push({type:'FOOTER', text:d.footer.text});
  }

  // Buttons
  if (d.buttons.length){
    var btns = d.buttons.map(function(b){
      var obj = {type:b.type, text:b.text};
      if (b.type==='URL') obj.url = b.value;
      if (b.type==='PHONE_NUMBER') obj.phone_number = b.value;
      return obj;
    });
    comps.push({type:'BUTTONS', buttons:btns});
  }

  return comps;
}

/* ─── SAVE / DELETE ──────────────────────────────────────────────── */
window.teSaveTemplate = async function(){
  var d = _teData;
  if (!d.name){ toast('Template name is required','err'); return; }
  if (!d.body.text){ toast('Body text is required','err'); return; }

  var payload = {
    name: d.name,
    category: d.category,
    language: d.language,
    components: buildComponents()
  };
  if (_teWabaId) payload.waba_id = _teWabaId;

  try {
    await api('/api/admin/templates',{method:'POST', body:payload});
    toast('Template saved','ok');
    closeTemplateEditor();
  } catch(e){ toast('Save failed: '+e.message,'err'); }
};

window.teDeleteTemplate = async function(){
  if (!confirm('Delete template "'+_teData.name+'"?')) return;
  try {
    await api('/api/admin/templates',{method:'DELETE', body:{name:_teData.name}});
    toast('Template deleted','ok');
    closeTemplateEditor();
  } catch(e){ toast('Delete failed: '+e.message,'err'); }
};

/* ─── SET WABA ID ────────────────────────────────────────────────── */
window.teSetWabaId = function(id){ _teWabaId = id; };

})();

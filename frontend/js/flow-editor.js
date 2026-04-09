// frontend/js/flow-editor.js
// Visual WhatsApp Flow Editor for Admin Dashboard
// Uses: api(), toast(), _esc() from admin.html globals
// DOM targets: #flow-editor-container, #fe-palette, #fe-screen-tabs,
//   #fe-screen-props, #fe-components, #fe-json-area, #fe-json-textarea,
//   #fe-nav-map, #fe-preview, #fe-flow-name, #fe-flow-status, #fe-mode-btn

(function () {
'use strict';

/* ─── STATE ──────────────────────────────────────────────────────── */
var _feFlowId    = null;
var _feJson      = null;   // { version:'6.2', screens:[...] }
var _feScreenIdx = 0;
var _feJsonMode  = false;

/* ─── COMPONENT DEFAULTS ─────────────────────────────────────────── */
var COMP_DEFAULTS = {
  TextHeading:       function(){ return { type:'TextHeading', text:'Heading' }; },
  TextSubheading:    function(){ return { type:'TextSubheading', text:'Subheading' }; },
  TextBody:          function(){ return { type:'TextBody', text:'Body text' }; },
  TextCaption:       function(){ return { type:'TextCaption', text:'Caption' }; },
  TextInput:         function(){ return { type:'TextInput', label:'Field', name:'field_1', 'input-type':'text', required:false }; },
  Dropdown:          function(){ return { type:'Dropdown', label:'Select', name:'dropdown_1', required:false, 'data-source':[{id:'opt1',title:'Option 1'}] }; },
  RadioButtonsGroup: function(){ return { type:'RadioButtonsGroup', label:'Choose', name:'radio_1', required:false, 'data-source':[{id:'opt1',title:'Option 1'}] }; },
  CheckboxGroup:     function(){ return { type:'CheckboxGroup', label:'Select', name:'check_1', required:false, 'data-source':[{id:'opt1',title:'Option 1'}] }; },
  OptIn:             function(){ return { type:'OptIn', label:'I agree', name:'optin_1', required:false }; },
  Footer:            function(){ return { type:'Footer', label:'Submit', 'on-click-action':{name:'complete',payload:{}} }; },
  NavigationList:    function(){ return { type:'NavigationList', label:'Items', name:'nav_1', 'list-items':'${data.items}', 'on-click-action':{name:'navigate',next:{type:'screen',name:''},payload:{}} }; },
  // Logic gate: conditional routing based on form field values
  If:                function(){ return { type:'If', name:'condition_1', _gb_logic:true, condition:{field:'',operator:'equals',value:''}, then_action:{name:'navigate',next:{type:'screen',name:''},payload:{}}, else_action:{name:'navigate',next:{type:'screen',name:''},payload:{}} }; },
};

var PALETTE = [
  { cat:'Text',       items:['TextHeading','TextSubheading','TextBody','TextCaption'] },
  { cat:'Input',      items:['TextInput','Dropdown','RadioButtonsGroup','CheckboxGroup','OptIn'] },
  { cat:'Navigation', items:['Footer','NavigationList'] },
  { cat:'Logic',      items:['If'] },
];

/* ─── HELPERS ────────────────────────────────────────────────────── */
function $(id){ return document.getElementById(id); }
function esc(s){ return typeof _esc==='function'? _esc(String(s||'')) : String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function curScreen(){ return (_feJson && _feJson.screens && _feJson.screens[_feScreenIdx]) || null; }

// curLayout MUST mutate the underlying _feJson — never return a throwaway array.
// If the screen is missing layout/children, normalize them in place so push() works.
function curLayout(){
  var s = curScreen();
  if (!s) return null;
  if (!s.layout) s.layout = { type:'SingleColumnLayout', children:[] };
  if (!Array.isArray(s.layout.children)) s.layout.children = [];
  return s.layout.children;
}

function blankFlow(){
  return { version:'6.2', screens:[{ id:'SCREEN_1', title:'Screen 1', terminal:true, layout:{ type:'SingleColumnLayout', children:[] } }] };
}

// Normalize any incoming flow JSON shape into the editor's internal model.
// Handles: malformed JSON, missing screens, missing layout, wrong child types, etc.
function normalizeFlow(input) {
  // Unwrap common wrapper shapes returned by APIs
  var raw = input;
  if (raw && typeof raw === 'object') {
    if (raw.flow_json && typeof raw.flow_json === 'object') raw = raw.flow_json;
    else if (raw.json && typeof raw.json === 'object') raw = raw.json;
  }
  if (!raw || typeof raw !== 'object') return blankFlow();

  var out = {
    version: raw.version || '6.2',
    screens: [],
  };
  // Preserve any other top-level fields (data_api_version, routing_model, etc.)
  Object.keys(raw).forEach(function(k){
    if (k !== 'version' && k !== 'screens') out[k] = raw[k];
  });

  var screens = Array.isArray(raw.screens) ? raw.screens : [];
  if (screens.length === 0) {
    out.screens = blankFlow().screens;
    return out;
  }

  out.screens = screens.map(function(s, i){
    if (!s || typeof s !== 'object') s = {};
    var screen = {
      id: s.id || ('SCREEN_' + (i + 1)),
      title: s.title || ('Screen ' + (i + 1)),
      terminal: !!s.terminal,
    };
    if (s.success !== undefined) screen.success = !!s.success;
    if (s.data && typeof s.data === 'object') screen.data = s.data;

    // Normalize layout
    var layout = s.layout || {};
    screen.layout = {
      type: layout.type || 'SingleColumnLayout',
      children: Array.isArray(layout.children) ? layout.children : [],
    };

    // Carry forward any other screen-level fields
    Object.keys(s).forEach(function(k){
      if (['id','title','terminal','success','data','layout'].indexOf(k) === -1) {
        screen[k] = s[k];
      }
    });

    return screen;
  });

  return out;
}

/* ─── OPEN / CLOSE ───────────────────────────────────────────────── */
window.openFlowEditor = async function(flowId){
  _feFlowId = flowId || null;
  _feScreenIdx = 0;
  _feJsonMode = false;
  $('fe-mode-btn').textContent = 'JSON Mode';
  $('fe-json-area').style.display = 'none';
  $('fe-components').style.display = '';

  if (_feFlowId) {
    try {
      var data = await api('/api/admin/flows/' + _feFlowId + '/json');
      // Backend returns { flow_json, asset_id, name?, status? }.
      // normalizeFlow() handles all wrapper shapes (flow_json, json, or raw).
      _feJson = normalizeFlow(data);
      $('fe-flow-name').textContent = (data && data.name) || ('Flow ' + _feFlowId);
      $('fe-flow-status').textContent = (data && data.status) || 'DRAFT';
    } catch(e) {
      toast('Failed to load flow: ' + e.message, 'err');
      _feJson = blankFlow();
    }
  } else {
    _feJson = blankFlow();
    $('fe-flow-name').textContent = 'New Flow';
    $('fe-flow-status').textContent = 'DRAFT';
  }

  // Defensive: if normalizeFlow somehow returned an empty screen list, fall back to blank
  if (!_feJson || !Array.isArray(_feJson.screens) || _feJson.screens.length === 0) {
    _feJson = blankFlow();
  }
  // Reset screen index if it's now out of range
  if (_feScreenIdx >= _feJson.screens.length) _feScreenIdx = 0;

  $('flow-editor-container').style.display = '';
  feRenderAll();
};

window.closeFlowEditor = function(){
  $('flow-editor-container').style.display = 'none';
  _feFlowId = null;
  _feJson = null;
};

/* ─── RENDER ALL ─────────────────────────────────────────────────── */
window.feRenderAll = function(){
  if (!_feJson) return;
  renderPalette();
  renderScreenTabs();
  renderScreenProps();
  renderComponents();
  renderNavMap();
  renderPreview();
};

/* ─── PALETTE ────────────────────────────────────────────────────── */
function renderPalette(){
  var h = '<div style="font-weight:700;margin-bottom:.5rem;font-size:.78rem;color:var(--dim);text-transform:uppercase;letter-spacing:.04em">Components</div>';
  PALETTE.forEach(function(g){
    h += '<div style="font-weight:600;font-size:.72rem;color:var(--mute);margin:.6rem 0 .25rem;text-transform:uppercase;letter-spacing:.04em">' + g.cat + '</div>';
    g.items.forEach(function(t){
      h += '<div onclick="feAddComponent(\'' + t + '\')" style="padding:.3rem .5rem;cursor:pointer;border-radius:5px;transition:background .1s;margin-bottom:2px" onmouseover="this.style.background=\'var(--ink4)\'" onmouseout="this.style.background=\'transparent\'">' + t + '</div>';
    });
  });
  $('fe-palette').innerHTML = h;
}

/* ─── SCREEN TABS ────────────────────────────────────────────────── */
function renderScreenTabs(){
  var screens = _feJson.screens || [];
  var h = '';
  screens.forEach(function(s, i){
    var active = i === _feScreenIdx;
    h += '<div onclick="feSelectScreen(' + i + ')" style="padding:.45rem .8rem;cursor:pointer;font-size:.78rem;font-weight:' + (active?'700':'500') + ';color:' + (active?'var(--acc)':'var(--dim)') + ';border-bottom:2px solid ' + (active?'var(--acc)':'transparent') + ';white-space:nowrap;transition:color .1s">' + esc(s.id || ('Screen '+(i+1))) + '</div>';
  });
  h += '<div onclick="feAddScreen()" style="padding:.45rem .6rem;cursor:pointer;font-size:.85rem;color:var(--mute);font-weight:700" title="Add screen">+</div>';
  $('fe-screen-tabs').innerHTML = h;
}

/* ─── SCREEN PROPERTIES ──────────────────────────────────────────── */
function renderScreenProps(){
  var s = curScreen();
  if (!s) { $('fe-screen-props').innerHTML = ''; return; }
  var h = '<div style="display:flex;gap:.6rem;align-items:center;flex-wrap:wrap">';
  h += '<label style="font-size:.72rem;color:var(--dim);font-weight:600">ID</label>';
  h += '<input value="' + esc(s.id) + '" onchange="feUpdateScreenProp(\'id\',this.value)" style="width:120px;background:var(--ink4);border:1px solid var(--rim);border-radius:5px;padding:.2rem .5rem;font-size:.78rem;font-family:monospace">';
  h += '<label style="font-size:.72rem;color:var(--dim);font-weight:600;margin-left:.5rem">Title</label>';
  h += '<input value="' + esc(s.title||'') + '" onchange="feUpdateScreenProp(\'title\',this.value)" style="width:150px;background:var(--ink4);border:1px solid var(--rim);border-radius:5px;padding:.2rem .5rem;font-size:.78rem">';
  h += '<label style="font-size:.72rem;color:var(--dim);font-weight:600;margin-left:.5rem">Terminal</label>';
  h += '<input type="checkbox" ' + (s.terminal?'checked':'') + ' onchange="feUpdateScreenProp(\'terminal\',this.checked)">';
  h += '<label style="font-size:.72rem;color:var(--dim);font-weight:600;margin-left:.5rem">Success</label>';
  h += '<input type="checkbox" ' + (s.success?'checked':'') + ' onchange="feUpdateScreenProp(\'success\',this.checked)">';
  if (_feJson.screens.length > 1) {
    h += '<button class="btn-sm outline danger" style="margin-left:auto;font-size:.7rem;padding:.15rem .5rem" onclick="feRemoveScreen(' + _feScreenIdx + ')">Remove Screen</button>';
  }
  h += '</div>';

  // Screen data schema editor (input variables this screen expects)
  var data = s.data || {};
  var dataKeys = Object.keys(data);
  h += '<div style="margin-top:.5rem;padding:.4rem;background:var(--ink4);border:1px solid var(--rim);border-radius:5px">';
  h += '<div style="display:flex;align-items:center;margin-bottom:.25rem"><span style="font-size:.7rem;font-weight:600;color:var(--dim)">Screen Data (input variables)</span>';
  h += '<button class="btn-sm" style="margin-left:auto;padding:.06rem .35rem;font-size:.62rem" onclick="feAddScreenDataField()">+ Add</button></div>';
  if (dataKeys.length === 0) {
    h += '<div style="font-size:.68rem;color:var(--mute);font-style:italic">No data fields. Add one if this screen needs input from a previous screen.</div>';
  }
  dataKeys.forEach(function(k){
    var v = data[k];
    var typeVal = typeof v === 'object' ? (v.type || 'string') : 'string';
    h += '<div style="display:flex;gap:.25rem;align-items:center;margin-bottom:.15rem">';
    h += '<input value="' + esc(k) + '" placeholder="key" style="width:80px;background:#fff;border:1px solid var(--rim);border-radius:4px;padding:.12rem .25rem;font-size:.7rem;font-family:monospace" onchange="feRenameScreenDataField(\'' + esc(k) + '\',this.value)">';
    h += '<select onchange="feUpdateScreenDataType(\'' + esc(k) + '\',this.value)" style="background:#fff;border:1px solid var(--rim);border-radius:4px;padding:.12rem .25rem;font-size:.7rem">';
    ['string','number','boolean','array','object'].forEach(function(t){
      h += '<option value="' + t + '"' + (typeVal===t?' selected':'') + '>' + t + '</option>';
    });
    h += '</select>';
    h += '<button style="background:none;border:none;color:var(--red);cursor:pointer;font-size:.75rem;padding:0 .15rem" onclick="feRemoveScreenDataField(\'' + esc(k) + '\')">&times;</button>';
    h += '</div>';
  });
  h += '</div>';

  $('fe-screen-props').innerHTML = h;
}

window.feUpdateScreenProp = function(prop, val){
  var s = curScreen();
  if (!s) return;
  s[prop] = val;
  if (prop === 'id') renderScreenTabs();
  if (prop === 'terminal') renderNavMap();
};

/* ─── COMPONENTS ─────────────────────────────────────────────────── */
function renderComponents(){
  var children = curLayout();
  if (!children) { $('fe-components').innerHTML = '<div style="padding:1rem;color:var(--dim)">No screen selected</div>'; return; }
  if (children.length === 0) {
    $('fe-components').innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--mute);font-size:.82rem">No components yet. Click items in the palette to add them.</div>';
    return;
  }
  var h = '';
  children.forEach(function(c, i){
    h += renderComponentCard(c, i, children.length);
  });
  $('fe-components').innerHTML = h;
}

function renderComponentCard(c, idx, total){
  var typeBadge = '<span style="display:inline-block;background:rgba(79,70,229,.08);color:var(--acc);font-size:.68rem;font-weight:700;padding:.1rem .4rem;border-radius:4px;letter-spacing:.02em">' + esc(c.type) + '</span>';
  var h = '<div style="background:var(--ink4);border:1px solid var(--rim);border-radius:var(--r);padding:.6rem;margin-bottom:.5rem">';
  // Header
  h += '<div style="display:flex;align-items:center;gap:.4rem;margin-bottom:.45rem">' + typeBadge;
  h += '<div style="margin-left:auto;display:flex;gap:.25rem">';
  if (idx > 0) h += '<button class="btn-sm" style="padding:.1rem .35rem;font-size:.7rem" onclick="feMoveComponent(' + idx + ',-1)" title="Move up">&uarr;</button>';
  if (idx < total - 1) h += '<button class="btn-sm" style="padding:.1rem .35rem;font-size:.7rem" onclick="feMoveComponent(' + idx + ',1)" title="Move down">&darr;</button>';
  h += '<button class="btn-sm outline danger" style="padding:.1rem .35rem;font-size:.7rem" onclick="feRemoveComponent(' + idx + ')" title="Remove">&times;</button>';
  h += '</div></div>';

  // Properties
  h += renderComponentProps(c, idx);
  h += '</div>';
  return h;
}

function renderComponentProps(c, idx){
  var h = '<div style="display:flex;flex-direction:column;gap:.35rem">';
  var skip = ['type','data-source','on-click-action','list-items'];

  Object.keys(c).forEach(function(key){
    if (skip.indexOf(key) !== -1) return;
    var val = c[key];
    if (typeof val === 'boolean') {
      h += '<div style="display:flex;align-items:center;gap:.4rem">';
      h += '<label style="font-size:.7rem;color:var(--dim);font-weight:600;min-width:60px">' + esc(key) + '</label>';
      h += '<input type="checkbox" ' + (val?'checked':'') + ' onchange="feUpdateComponent(' + idx + ',\'' + esc(key) + '\',this.checked)">';
      h += '</div>';
    } else {
      h += '<div style="display:flex;align-items:center;gap:.4rem">';
      h += '<label style="font-size:.7rem;color:var(--dim);font-weight:600;min-width:60px">' + esc(key) + '</label>';
      h += '<input value="' + esc(val) + '" onchange="feUpdateComponent(' + idx + ',\'' + esc(key) + '\',this.value)" style="flex:1;background:#fff;border:1px solid var(--rim);border-radius:5px;padding:.2rem .4rem;font-size:.78rem">';
      h += '</div>';
    }
  });

  // data-source editor
  if (c['data-source']) {
    h += renderDataSourceEditor(c, idx);
  }

  // on-click-action editor
  if (c['on-click-action']) {
    h += renderActionEditor(c, idx);
  }

  // Conditional / logic gate editor
  if (c._gb_logic) {
    h += renderConditionEditor(c, idx);
  }

  h += '</div>';
  return h;
}

function renderDataSourceEditor(c, idx){
  var ds = c['data-source'] || [];
  var h = '<div style="margin-top:.3rem;padding:.4rem;background:#fff;border:1px solid var(--rim);border-radius:5px">';
  h += '<div style="display:flex;align-items:center;margin-bottom:.3rem"><span style="font-size:.7rem;font-weight:600;color:var(--dim)">data-source</span>';
  h += '<button class="btn-sm" style="margin-left:auto;padding:.08rem .35rem;font-size:.65rem" onclick="feAddDataSourceItem(' + idx + ')">+ Add</button></div>';
  ds.forEach(function(item, ii){
    h += '<div style="display:flex;gap:.3rem;align-items:center;margin-bottom:.2rem">';
    h += '<input value="' + esc(item.id) + '" placeholder="id" onchange="feUpdateDataSourceItem(' + idx + ',' + ii + ',\'id\',this.value)" style="width:70px;background:var(--ink4);border:1px solid var(--rim);border-radius:4px;padding:.15rem .3rem;font-size:.72rem">';
    h += '<input value="' + esc(item.title) + '" placeholder="title" onchange="feUpdateDataSourceItem(' + idx + ',' + ii + ',\'title\',this.value)" style="flex:1;background:var(--ink4);border:1px solid var(--rim);border-radius:4px;padding:.15rem .3rem;font-size:.72rem">';
    h += '<button style="background:none;border:none;color:var(--red);cursor:pointer;font-size:.8rem;padding:0 .2rem" onclick="feRemoveDataSourceItem(' + idx + ',' + ii + ')">&times;</button>';
    h += '</div>';
  });
  h += '</div>';
  return h;
}

function renderActionEditor(c, idx){
  var act = c['on-click-action'] || {};
  var screens = _feJson.screens || [];
  var h = '<div style="margin-top:.3rem;padding:.4rem;background:#fff;border:1px solid var(--rim);border-radius:5px">';
  h += '<div style="font-size:.7rem;font-weight:600;color:var(--dim);margin-bottom:.3rem">on-click-action</div>';

  // Action name
  h += '<div style="display:flex;gap:.3rem;align-items:center;margin-bottom:.25rem">';
  h += '<label style="font-size:.68rem;color:var(--dim);min-width:50px">action</label>';
  h += '<select onchange="feUpdateActionProp(' + idx + ',\'name\',this.value)" style="background:#fff;border:1px solid var(--rim);border-radius:4px;padding:.15rem .3rem;font-size:.72rem">';
  ['navigate','complete','data_exchange'].forEach(function(n){
    h += '<option value="' + n + '"' + (act.name===n?' selected':'') + '>' + n + '</option>';
  });
  h += '</select></div>';

  // Next screen (for navigate)
  if (act.name === 'navigate' && act.next) {
    h += '<div style="display:flex;gap:.3rem;align-items:center;margin-bottom:.25rem">';
    h += '<label style="font-size:.68rem;color:var(--dim);min-width:50px">next</label>';
    h += '<select onchange="feUpdateActionProp(' + idx + ',\'next_screen\',this.value)" style="background:#fff;border:1px solid var(--rim);border-radius:4px;padding:.15rem .3rem;font-size:.72rem">';
    h += '<option value="">-- select --</option>';
    screens.forEach(function(s){
      var sel = (act.next && act.next.name === s.id) ? ' selected' : '';
      h += '<option value="' + esc(s.id) + '"' + sel + '>' + esc(s.id) + '</option>';
    });
    h += '</select></div>';
  }

  // Payload fields
  var payload = act.payload || {};
  var keys = Object.keys(payload);
  h += '<div style="display:flex;align-items:center;margin:.25rem 0 .15rem"><span style="font-size:.68rem;color:var(--dim)">payload</span>';
  h += '<button class="btn-sm" style="margin-left:auto;padding:.06rem .3rem;font-size:.62rem" onclick="feAddPayloadField(' + idx + ')">+ field</button></div>';
  keys.forEach(function(k){
    h += '<div style="display:flex;gap:.25rem;align-items:center;margin-bottom:.15rem">';
    h += '<input value="' + esc(k) + '" placeholder="key" style="width:70px;background:var(--ink4);border:1px solid var(--rim);border-radius:4px;padding:.12rem .25rem;font-size:.7rem" onchange="feRenamePayloadField(' + idx + ',\'' + esc(k) + '\',this.value)">';
    h += '<input value="' + esc(payload[k]) + '" placeholder="value" style="flex:1;background:var(--ink4);border:1px solid var(--rim);border-radius:4px;padding:.12rem .25rem;font-size:.7rem" onchange="feUpdatePayloadValue(' + idx + ',\'' + esc(k) + '\',this.value)">';
    h += '<button style="background:none;border:none;color:var(--red);cursor:pointer;font-size:.75rem;padding:0 .15rem" onclick="feRemovePayloadField(' + idx + ',\'' + esc(k) + '\')">&times;</button>';
    h += '</div>';
  });

  h += '</div>';
  return h;
}

/* ─── CONDITIONAL / LOGIC GATE EDITOR ───────────────────────────── */
function renderConditionEditor(c, idx){
  var cond = c.condition || {};
  var screens = _feJson.screens || [];
  var thenAct = c.then_action || {};
  var elseAct = c.else_action || {};

  // Collect all form field names from current screen's input components
  var formFields = [];
  (curLayout() || []).forEach(function(comp, ci){
    if (ci === idx) return; // skip self
    if (comp.name && (comp.type === 'TextInput' || comp.type === 'Dropdown' || comp.type === 'RadioButtonsGroup' || comp.type === 'CheckboxGroup')) {
      formFields.push(comp.name);
    }
  });

  var h = '<div style="margin-top:.35rem;padding:.5rem;background:linear-gradient(135deg,#fef3c710,#dbeafe15);border:1px solid #fde68a;border-radius:6px">';
  h += '<div style="font-size:.72rem;font-weight:700;color:#92400e;margin-bottom:.35rem">CONDITION</div>';

  // Field selector
  h += '<div style="display:flex;gap:.3rem;align-items:center;margin-bottom:.25rem">';
  h += '<label style="font-size:.68rem;color:var(--dim);min-width:35px">IF</label>';
  h += '<select onchange="feUpdateCondition(' + idx + ',\'field\',this.value)" style="background:#fff;border:1px solid var(--rim);border-radius:4px;padding:.15rem .3rem;font-size:.72rem">';
  h += '<option value="">-- field --</option>';
  formFields.forEach(function(f){
    h += '<option value="' + esc(f) + '"' + (cond.field===f?' selected':'') + '>${form.' + esc(f) + '}</option>';
  });
  h += '</select>';

  // Operator
  h += '<select onchange="feUpdateCondition(' + idx + ',\'operator\',this.value)" style="background:#fff;border:1px solid var(--rim);border-radius:4px;padding:.15rem .3rem;font-size:.72rem">';
  ['equals','not_equals','contains','is_empty','is_not_empty'].forEach(function(op){
    h += '<option value="' + op + '"' + (cond.operator===op?' selected':'') + '>' + op.replace(/_/g,' ') + '</option>';
  });
  h += '</select>';

  // Value (hidden for is_empty/is_not_empty)
  if (cond.operator !== 'is_empty' && cond.operator !== 'is_not_empty') {
    h += '<input value="' + esc(cond.value||'') + '" placeholder="value" onchange="feUpdateCondition(' + idx + ',\'value\',this.value)" style="width:80px;background:#fff;border:1px solid var(--rim);border-radius:4px;padding:.15rem .3rem;font-size:.72rem">';
  }
  h += '</div>';

  // THEN: navigate to
  h += '<div style="display:flex;gap:.3rem;align-items:center;margin-bottom:.25rem">';
  h += '<label style="font-size:.68rem;color:#16a34a;font-weight:600;min-width:35px">THEN</label>';
  h += '<select onchange="feUpdateBranchAction(' + idx + ',\'then_action\',this.value)" style="background:#fff;border:1px solid var(--rim);border-radius:4px;padding:.15rem .3rem;font-size:.72rem">';
  h += '<option value="">-- go to screen --</option>';
  screens.forEach(function(s){
    h += '<option value="' + esc(s.id) + '"' + ((thenAct.next && thenAct.next.name===s.id)?' selected':'') + '>' + esc(s.id) + '</option>';
  });
  h += '</select></div>';

  // ELSE: navigate to
  h += '<div style="display:flex;gap:.3rem;align-items:center">';
  h += '<label style="font-size:.68rem;color:#dc2626;font-weight:600;min-width:35px">ELSE</label>';
  h += '<select onchange="feUpdateBranchAction(' + idx + ',\'else_action\',this.value)" style="background:#fff;border:1px solid var(--rim);border-radius:4px;padding:.15rem .3rem;font-size:.72rem">';
  h += '<option value="">-- go to screen --</option>';
  screens.forEach(function(s){
    h += '<option value="' + esc(s.id) + '"' + ((elseAct.next && elseAct.next.name===s.id)?' selected':'') + '>' + esc(s.id) + '</option>';
  });
  h += '</select></div>';

  h += '</div>';
  return h;
}

window.feUpdateCondition = function(compIdx, prop, value){
  var children = curLayout();
  if (!children || !children[compIdx]) return;
  if (!children[compIdx].condition) children[compIdx].condition = {};
  children[compIdx].condition[prop] = value;
  renderComponents();
  renderNavMap();
};

window.feUpdateBranchAction = function(compIdx, actionKey, screenId){
  var children = curLayout();
  if (!children || !children[compIdx]) return;
  children[compIdx][actionKey] = {
    name: 'navigate',
    next: { type: 'screen', name: screenId },
    payload: children[compIdx][actionKey]?.payload || {},
  };
  renderComponents();
  renderNavMap();
};

/* ─── NAVIGATION MAP ─────────────────────────────────────────────── */
function renderNavMap(){
  var screens = _feJson.screens || [];
  if (screens.length === 0) { $('fe-nav-map').innerHTML = ''; return; }

  // Build adjacency from on-click-actions and conditional logic
  var edges = {};
  screens.forEach(function(s){
    edges[s.id] = [];
    (s.layout.children || []).forEach(function(c){
      var act = c['on-click-action'];
      if (act && act.name === 'navigate' && act.next && act.next.name) {
        edges[s.id].push(act.next.name);
      }
      // Conditional branches
      if (c._gb_logic) {
        if (c.then_action?.next?.name) edges[s.id].push('IF\u2192' + c.then_action.next.name);
        if (c.else_action?.next?.name) edges[s.id].push('ELSE\u2192' + c.else_action.next.name);
      }
    });
  });

  var parts = screens.map(function(s){
    var label = s.id;
    if (s.terminal) label += ' (terminal)';
    var targets = edges[s.id] || [];
    if (targets.length > 0) label += ' \u2192 ' + targets.join(', ');
    return label;
  });

  $('fe-nav-map').innerHTML = '<strong>Navigation:</strong> ' + esc(parts.join('  |  '));
}

/* ─── PREVIEW ────────────────────────────────────────────────────── */
function renderPreview(){
  var s = curScreen();
  if (!s) { $('fe-preview').innerHTML = ''; return; }
  var children = s.layout.children || [];
  var h = '<div style="background:#fff;border-radius:12px;padding:.8rem;max-width:260px;margin:0 auto;box-shadow:0 1px 4px rgba(0,0,0,.12);min-height:200px;display:flex;flex-direction:column">';

  // Title bar
  h += '<div style="font-size:.78rem;font-weight:700;color:#1a1a1a;padding:.3rem 0 .5rem;border-bottom:1px solid #eee;margin-bottom:.5rem">' + esc(s.title || s.id) + '</div>';

  children.forEach(function(c){
    h += previewComponent(c);
  });

  h += '</div>';
  $('fe-preview').innerHTML = h;
}

function previewComponent(c){
  var h = '';
  switch(c.type){
    case 'TextHeading':
      h = '<div style="font-size:.95rem;font-weight:700;color:#1a1a1a;margin:.3rem 0">' + esc(c.text) + '</div>';
      break;
    case 'TextSubheading':
      h = '<div style="font-size:.82rem;font-weight:600;color:#333;margin:.25rem 0">' + esc(c.text) + '</div>';
      break;
    case 'TextBody':
      h = '<div style="font-size:.78rem;color:#444;margin:.2rem 0">' + esc(c.text) + '</div>';
      break;
    case 'TextCaption':
      h = '<div style="font-size:.68rem;color:#888;margin:.15rem 0">' + esc(c.text) + '</div>';
      break;
    case 'TextInput':
      h = '<div style="margin:.35rem 0"><div style="font-size:.68rem;color:#666;margin-bottom:.15rem">' + esc(c.label) + (c.required?' *':'') + '</div>';
      h += '<div style="border:1px solid #ccc;border-radius:6px;padding:.3rem .5rem;font-size:.72rem;color:#aaa">' + esc(c['input-type']||'text') + '</div></div>';
      break;
    case 'Dropdown':
      h = '<div style="margin:.35rem 0"><div style="font-size:.68rem;color:#666;margin-bottom:.15rem">' + esc(c.label) + (c.required?' *':'') + '</div>';
      h += '<div style="border:1px solid #ccc;border-radius:6px;padding:.3rem .5rem;font-size:.72rem;color:#888;display:flex;justify-content:space-between">Select <span style="font-size:.6rem">\u25BC</span></div></div>';
      break;
    case 'RadioButtonsGroup':
      h = '<div style="margin:.35rem 0"><div style="font-size:.68rem;color:#666;margin-bottom:.2rem">' + esc(c.label) + '</div>';
      (c['data-source']||[]).forEach(function(o){
        h += '<div style="display:flex;align-items:center;gap:.3rem;margin-bottom:.15rem"><span style="width:14px;height:14px;border:1.5px solid #999;border-radius:50%;display:inline-block;flex-shrink:0"></span><span style="font-size:.72rem;color:#444">' + esc(o.title) + '</span></div>';
      });
      h += '</div>';
      break;
    case 'CheckboxGroup':
      h = '<div style="margin:.35rem 0"><div style="font-size:.68rem;color:#666;margin-bottom:.2rem">' + esc(c.label) + '</div>';
      (c['data-source']||[]).forEach(function(o){
        h += '<div style="display:flex;align-items:center;gap:.3rem;margin-bottom:.15rem"><span style="width:14px;height:14px;border:1.5px solid #999;border-radius:3px;display:inline-block;flex-shrink:0"></span><span style="font-size:.72rem;color:#444">' + esc(o.title) + '</span></div>';
      });
      h += '</div>';
      break;
    case 'OptIn':
      h = '<div style="display:flex;align-items:center;gap:.35rem;margin:.35rem 0"><span style="width:14px;height:14px;border:1.5px solid #999;border-radius:3px;display:inline-block;flex-shrink:0"></span><span style="font-size:.72rem;color:#444">' + esc(c.label) + '</span></div>';
      break;
    case 'Footer':
      h = '<div style="margin-top:auto;padding-top:.5rem"><button style="width:100%;background:#25D366;color:#fff;border:none;border-radius:20px;padding:.45rem;font-size:.78rem;font-weight:600;cursor:default">' + esc(c.label) + '</button></div>';
      break;
    case 'NavigationList':
      h = '<div style="margin:.35rem 0;border:1px solid #ddd;border-radius:8px;overflow:hidden">';
      h += '<div style="padding:.35rem .5rem;font-size:.72rem;font-weight:600;color:#444;background:#f5f5f5">' + esc(c.label) + '</div>';
      h += '<div style="padding:.25rem .5rem;font-size:.68rem;color:#888">Dynamic list items</div>';
      h += '</div>';
      break;
    case 'If':
      var cond = c.condition || {};
      h = '<div style="margin:.35rem 0;border:1px dashed #fde68a;border-radius:6px;padding:.4rem;background:#fefce8">';
      h += '<div style="font-size:.68rem;font-weight:700;color:#92400e;margin-bottom:.2rem">IF ' + esc(cond.field ? '${form.' + cond.field + '}' : '?') + ' ' + esc((cond.operator||'').replace(/_/g,' ')) + ' ' + esc(cond.value||'') + '</div>';
      h += '<div style="font-size:.65rem;color:#16a34a">THEN \u2192 ' + esc(c.then_action?.next?.name || '?') + '</div>';
      h += '<div style="font-size:.65rem;color:#dc2626">ELSE \u2192 ' + esc(c.else_action?.next?.name || '?') + '</div>';
      h += '</div>';
      break;
    default:
      h = '<div style="margin:.2rem 0;font-size:.72rem;color:#999;font-style:italic">[' + esc(c.type) + ']</div>';
  }
  return h;
}

/* ─── SCREEN ACTIONS ─────────────────────────────────────────────── */
window.feSelectScreen = function(idx){
  _feScreenIdx = idx;
  renderScreenTabs();
  renderScreenProps();
  renderComponents();
  renderNavMap();
  renderPreview();
};

window.feAddScreen = function(){
  var screens = _feJson.screens || [];
  var num = screens.length + 1;
  var id = 'SCREEN_' + num;
  // Avoid duplicate IDs
  while (screens.some(function(s){ return s.id === id; })) { num++; id = 'SCREEN_' + num; }
  screens.push({ id: id, title: 'Screen ' + num, terminal: false, layout:{ type:'SingleColumnLayout', children:[] } });
  _feScreenIdx = screens.length - 1;
  feRenderAll();
};

window.feRemoveScreen = function(idx){
  if (!confirm('Remove screen "' + (_feJson.screens[idx].id || 'Screen '+(idx+1)) + '"?')) return;
  _feJson.screens.splice(idx, 1);
  if (_feScreenIdx >= _feJson.screens.length) _feScreenIdx = Math.max(0, _feJson.screens.length - 1);
  feRenderAll();
};

/* ─── SCREEN DATA FIELD ACTIONS ──────────────────────────────────── */
window.feAddScreenDataField = function(){
  var s = curScreen();
  if (!s) return;
  if (!s.data) s.data = {};
  var num = Object.keys(s.data).length + 1;
  var key = 'field_' + num;
  while (s.data[key]) { num++; key = 'field_' + num; }
  s.data[key] = { type: 'string', '__example__': '' };
  renderScreenProps();
};

window.feRenameScreenDataField = function(oldKey, newKey){
  var s = curScreen();
  if (!s || !s.data || !newKey) return;
  if (oldKey === newKey) return;
  s.data[newKey] = s.data[oldKey];
  delete s.data[oldKey];
  renderScreenProps();
};

window.feUpdateScreenDataType = function(key, type){
  var s = curScreen();
  if (!s || !s.data || !s.data[key]) return;
  if (typeof s.data[key] === 'object') { s.data[key].type = type; }
  else { s.data[key] = { type: type, '__example__': '' }; }
  renderScreenProps();
};

window.feRemoveScreenDataField = function(key){
  var s = curScreen();
  if (!s || !s.data) return;
  delete s.data[key];
  if (Object.keys(s.data).length === 0) delete s.data;
  renderScreenProps();
};

/* ─── COMPONENT ACTIONS ──────────────────────────────────────────── */
window.feAddComponent = function(type){
  // Defensive: if no flow loaded yet, refuse politely
  if (!_feJson) { toast('No flow loaded', 'err'); return; }

  // Defensive: if no screen exists, auto-create one
  if (!_feJson.screens || _feJson.screens.length === 0) {
    _feJson.screens = [{ id:'SCREEN_1', title:'Screen 1', terminal:true, layout:{ type:'SingleColumnLayout', children:[] } }];
    _feScreenIdx = 0;
    renderScreenTabs();
    renderScreenProps();
  }
  // Defensive: if current screen index is out of range, reset
  if (_feScreenIdx >= _feJson.screens.length) _feScreenIdx = 0;

  var children = curLayout(); // now guaranteed to mutate _feJson directly
  if (!children) {
    toast('No screen selected', 'err');
    return;
  }

  var factory = COMP_DEFAULTS[type];
  if (!factory) { toast('Unknown component: ' + type, 'err'); return; }
  var comp = factory();

  // Make names unique within the current screen
  if (comp.name) {
    var base = comp.name.replace(/_\d+$/, '');
    var count = children.filter(function(c){ return c.name && c.name.indexOf(base) === 0; }).length;
    if (count > 0) comp.name = base + '_' + (count + 1);
  }
  children.push(comp);

  renderComponents();
  renderNavMap();
  renderPreview();
};

window.feRemoveComponent = function(idx){
  var children = curLayout();
  if (!children || idx < 0 || idx >= children.length) return;
  children.splice(idx, 1);
  renderComponents();
  renderNavMap();
  renderPreview();
};

window.feMoveComponent = function(idx, dir){
  var children = curLayout();
  if (!children) return;
  var target = idx + dir;
  if (target < 0 || target >= children.length) return;
  var temp = children[idx];
  children[idx] = children[target];
  children[target] = temp;
  renderComponents();
  renderPreview();
};

window.feUpdateComponent = function(idx, prop, value){
  var children = curLayout();
  if (!children || !children[idx]) return;
  children[idx][prop] = value;
  renderPreview();
};

/* ─── DATA SOURCE ACTIONS ────────────────────────────────────────── */
window.feAddDataSourceItem = function(compIdx){
  var children = curLayout();
  if (!children || !children[compIdx]) return;
  var ds = children[compIdx]['data-source'];
  if (!ds) return;
  var num = ds.length + 1;
  ds.push({ id: 'opt' + num, title: 'Option ' + num });
  renderComponents();
  renderPreview();
};

window.feRemoveDataSourceItem = function(compIdx, itemIdx){
  var children = curLayout();
  if (!children || !children[compIdx]) return;
  var ds = children[compIdx]['data-source'];
  if (!ds) return;
  ds.splice(itemIdx, 1);
  renderComponents();
  renderPreview();
};

window.feUpdateDataSourceItem = function(compIdx, itemIdx, prop, value){
  var children = curLayout();
  if (!children || !children[compIdx]) return;
  var ds = children[compIdx]['data-source'];
  if (!ds || !ds[itemIdx]) return;
  ds[itemIdx][prop] = value;
  renderPreview();
};

/* ─── ACTION EDITOR ACTIONS ──────────────────────────────────────── */
window.feUpdateActionProp = function(compIdx, prop, value){
  var children = curLayout();
  if (!children || !children[compIdx]) return;
  var act = children[compIdx]['on-click-action'];
  if (!act) return;
  if (prop === 'name') {
    act.name = value;
    if (value === 'navigate' && !act.next) act.next = { type:'screen', name:'' };
    if (value !== 'navigate') delete act.next;
    renderComponents(); // re-render to show/hide next screen selector
  } else if (prop === 'next_screen') {
    if (!act.next) act.next = { type:'screen', name:'' };
    act.next.name = value;
  }
  renderNavMap();
  renderPreview();
};

window.feAddPayloadField = function(compIdx){
  var children = curLayout();
  if (!children || !children[compIdx]) return;
  var act = children[compIdx]['on-click-action'];
  if (!act) return;
  if (!act.payload) act.payload = {};
  var num = Object.keys(act.payload).length + 1;
  act.payload['key_' + num] = '${form.field}';
  renderComponents();
};

window.feRemovePayloadField = function(compIdx, key){
  var children = curLayout();
  if (!children || !children[compIdx]) return;
  var act = children[compIdx]['on-click-action'];
  if (!act || !act.payload) return;
  delete act.payload[key];
  renderComponents();
};

window.feRenamePayloadField = function(compIdx, oldKey, newKey){
  var children = curLayout();
  if (!children || !children[compIdx]) return;
  var act = children[compIdx]['on-click-action'];
  if (!act || !act.payload) return;
  if (newKey === oldKey) return;
  var val = act.payload[oldKey];
  delete act.payload[oldKey];
  act.payload[newKey] = val;
  renderComponents();
};

window.feUpdatePayloadValue = function(compIdx, key, value){
  var children = curLayout();
  if (!children || !children[compIdx]) return;
  var act = children[compIdx]['on-click-action'];
  if (!act || !act.payload) return;
  act.payload[key] = value;
};

/* ─── SAVE / PUBLISH ─────────────────────────────────────────────── */
window.feSaveFlow = async function(){
  if (!_feFlowId) { toast('No flow ID to save to', 'err'); return; }
  // Sync from JSON mode if active
  if (_feJsonMode) {
    try {
      _feJson = normalizeFlow(JSON.parse($('fe-json-textarea').value));
    } catch(e) {
      toast('Invalid JSON: ' + e.message, 'err');
      return;
    }
  }
  if (!_feJson || !Array.isArray(_feJson.screens) || _feJson.screens.length === 0) {
    toast('Cannot save empty flow', 'err');
    return;
  }
  try {
    await api('/api/admin/flows/' + _feFlowId, { method:'PUT', body: _feJson });
    toast('Flow saved', 'ok');
  } catch(e) {
    toast('Save failed: ' + e.message, 'err');
  }
};

window.fePublishFlow = async function(){
  if (!_feFlowId) { toast('No flow ID', 'err'); return; }
  if (!confirm('Publish this flow? This action cannot be undone.')) return;
  try {
    await api('/api/admin/flows/' + _feFlowId + '/publish', { method:'POST' });
    toast('Flow published', 'ok');
    $('fe-flow-status').textContent = 'PUBLISHED';
  } catch(e) {
    toast('Publish failed: ' + e.message, 'err');
  }
};

/* ─── JSON MODE ──────────────────────────────────────────────────── */
window.feToggleJsonMode = function(){
  _feJsonMode = !_feJsonMode;
  if (_feJsonMode) {
    // Switch to JSON mode
    $('fe-json-textarea').value = JSON.stringify(_feJson, null, 2);
    $('fe-components').style.display = 'none';
    $('fe-json-area').style.display = '';
    $('fe-mode-btn').textContent = 'Visual Mode';
  } else {
    // Switch back to visual - parse JSON and normalize
    try {
      var parsed = JSON.parse($('fe-json-textarea').value);
      _feJson = normalizeFlow(parsed);
    } catch(e) {
      toast('Invalid JSON: ' + e.message, 'err');
      _feJsonMode = true;
      return;
    }
    $('fe-components').style.display = '';
    $('fe-json-area').style.display = 'none';
    $('fe-mode-btn').textContent = 'JSON Mode';
    if (_feScreenIdx >= _feJson.screens.length) _feScreenIdx = 0;
    feRenderAll();
  }
};

/* ─── EXPORT ─────────────────────────────────────────────────────── */
window.feExportJson = function(){
  if (!_feJson) return;
  // Sync from JSON mode if active
  var json = _feJson;
  if (_feJsonMode) {
    try { json = JSON.parse($('fe-json-textarea').value); } catch(e) {
      toast('Invalid JSON, cannot export', 'err'); return;
    }
  }
  var blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = (_feFlowId ? 'flow_' + _feFlowId : 'flow') + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('JSON exported', 'ok');
};

})();

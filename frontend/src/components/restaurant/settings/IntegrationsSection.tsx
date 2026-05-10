'use client';

interface IntDef {
  key: string;
  name: string;
  emoji: string;
  cls: string;
  desc: string;
}

const INT_DEFS: ReadonlyArray<IntDef> = [
  {
    key: 'petpooja',
    name: 'PetPooja',
    emoji: '🟣',
    cls: 'petpooja',
    desc: 'Sync your PetPooja POS menu directly — categories, items, prices and availability.',
  },
  {
    key: 'urbanpiper',
    name: 'UrbanPiper',
    emoji: '🔵',
    cls: 'urbanpiper',
    desc: 'Connect via UrbanPiper to sync menus from Swiggy, Zomato & more. Orders auto-push to your POS.',
  },
  {
    key: 'dotpe',
    name: 'DotPe',
    emoji: '🟡',
    cls: 'dotpe',
    desc: 'Sync your DotPe POS menu and push WhatsApp orders to your DotPe dashboard automatically.',
  },
  /* ═══ FUTURE FEATURE: Swiggy Integration ═══
     Requires Swiggy Partner API approval (apply at partner.swiggy.com).
     { key:'swiggy', name:'Swiggy', emoji:'🟠', cls:'swiggy',
       desc:'Pull your Swiggy menu automatically. Requires official Swiggy Partner API access.' },
     ═══ END FUTURE FEATURE ═══ */
  /* ═══ FUTURE FEATURE: Zomato Integration ═══
     Requires Zomato for Business API approval (apply at zomato.com/business).
     { key:'zomato', name:'Zomato', emoji:'🔴', cls:'zomato',
       desc:'Import your Zomato menu automatically. Requires Zomato for Business API credentials.' },
     ═══ END FUTURE FEATURE ═══ */
];

/* ═══ FUTURE FEATURE: POS_DISABLED flip ═══
   When the backend enables POS integrations, render live tiles via
   onClick={openIntModal(key)} + doToggleInt + doSaveIntegration + doSyncIntegration
   (legacy settings.js:1803-2019). For now POS_DISABLED=true always.
   ═══ END FUTURE FEATURE ═══ */

export default function IntegrationsSection() {
  return (
    <div>
      <div className="notice wa mb-5">
        <div className="notice-ico">🔗</div>
        <div className="notice-body">
          <h4>POS &amp; Platform Integrations — Coming Soon</h4>
          <p>
            POS integrations (PetPooja, UrbanPiper, DotPe) are not yet active. Once enabled, your
            POS menu syncs automatically into GullyBite and gets pushed to your WhatsApp Catalog.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {INT_DEFS.map((d) => (
          <div
            key={d.key}
            className="notice opacity-60"
          >
            <div className="notice-ico">{d.emoji}</div>
            <div className="notice-body">
              <div className="flex items-center gap-2 flex-wrap">
                <strong className="text-md">{d.name}</strong>
                <span className="badge bd">Coming soon</span>
              </div>
              <p className="text-sm text-dim mt-1 mb-0">{d.desc}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="card mt-5">
        <div className="ch"><h3>Sync Log</h3></div>
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Platform</th>
                <th>Branch</th>
                <th>Items</th>
                <th>Variants</th>
                <th>Last Synced</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={7} className="text-center p-8 text-dim">
                  POS integrations are not yet active. Contact GullyBite support for early access.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

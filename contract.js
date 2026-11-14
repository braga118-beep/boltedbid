// Folio home improvement contract (Massachusetts and Rhode Island).
// Builds the contract from the company profile and the estimate, shows it on the
// customer's page for signing, and makes the signed PDF.
// Wording approved by the contractor; have an attorney review before relying on it.
(function () {
  'use strict';
  const D = window.Doc;
  const { esc, nl, money, num, fmtDate } = D;

  // ---------------- State: job address first, then the license listed first ----------------
  function stateOf(text) {
    const t = ' ' + String(text || '').replace(/\n/g, ', ') + ' ';
    if (/\b(rhode island|R\.?I\.?)\b(?![a-z])/i.test(t) || /\b02[89]\d\d\b/.test(t)) return 'RI';
    if (/\b(massachusetts|mass\.|M\.?A\.?)\b(?![a-z])/i.test(t) || /\b0(1\d|2[0-7])\d\d\b/.test(t)) return 'MA';
    return '';
  }
  function contractState(doc, co) {
    if (doc.contract_state === 'MA' || doc.contract_state === 'RI') return { state: doc.contract_state, from: 'Chosen on this estimate' };
    const fromJob = stateOf(doc.job_site) || stateOf(doc.customer_address);
    if (fromJob) return { state: fromJob, from: 'From the job address' };
    const first = co.primary_state === 'RI' || co.primary_state === 'MA' ? co.primary_state : (co.hic_no ? 'MA' : co.ri_reg_no ? 'RI' : stateOf(co.address) || 'MA');
    return { state: first, from: 'From your first-listed license, because the job address has no state' };
  }

  // ---------------- Business days (Sundays and federal holidays don't count) ----------------
  function nthWeekday(y, m, wd, n) { const d = new Date(y, m, 1); const add = (wd - d.getDay() + 7) % 7; return new Date(y, m, 1 + add + (n - 1) * 7); }
  function lastWeekday(y, m, wd) { const d = new Date(y, m + 1, 0); return new Date(y, m, d.getDate() - ((d.getDay() - wd + 7) % 7)); }
  function holidays(y) {
    const f = (d) => d.toDateString();
    return new Set([
      new Date(y, 0, 1), nthWeekday(y, 0, 1, 3), nthWeekday(y, 1, 1, 3), lastWeekday(y, 4, 1), new Date(y, 5, 19), new Date(y, 6, 4),
      nthWeekday(y, 8, 1, 1), nthWeekday(y, 9, 1, 2), new Date(y, 10, 11), nthWeekday(y, 10, 4, 4), new Date(y, 11, 25)
    ].map(f));
  }
  function addBusinessDays(date, n) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    let left = n;
    while (left > 0) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() !== 0 && !holidays(d.getFullYear()).has(d.toDateString())) left--;
    }
    return d;
  }
  const longDate = (d) => d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const dateTime = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  // ---------------- What's needed before a contract can go out ----------------
  function issues(doc, co) {
    const { state } = contractState(doc, co);
    const out = [];
    const need = (ok, what) => { if (!ok) out.push(what); };
    need(co.address, 'Company street address (Companies)');
    need(state === 'MA' ? co.hic_no : co.ri_reg_no, state === 'MA' ? 'MA HIC registration number (Companies)' : 'RI contractor registration number (Companies)');
    need(co.signer_name, 'Name of the person signing for the company (Companies)');
    need(co.contractor_signature, 'Your saved signature (Companies)');
    need(co.insurance_amount, 'General liability insurance amount (Companies)');
    need(doc.customer_name, 'Customer name');
    need(doc.job_site || doc.customer_address, 'Job address');
    return out;
  }

  // When each payment is due, read from its name: "booking"/"deposit" first = before work starts,
  // "start"/"day 1" = the day work starts, "completion"/"final" = at completion, anything else = at that milestone.
  function dueWhen(m, i, n) {
    const name = String(m.name || '').toLowerCase();
    if (/complet|final|finish/.test(name) || (i === n - 1 && n > 1 && !/start|day 1/.test(name))) return 'At completion';
    if (/start|day 1|first day|begin/.test(name) && !(i === 0 && /book|sign/.test(name))) return 'On the day work starts';
    if (i === 0 || /book|deposit|sign/.test(name)) return 'Before work starts';
    return 'When this milestone is reached';
  }

  // ---------------- The contract ----------------
  // ctx = { doc, co, sig } where sig is the saved signature (null before signing).
  function blocks(ctx) {
    const { doc, co } = ctx;
    const sig = ctx.sig || null;
    const { state } = contractState(doc, co);
    const MA = state === 'MA', RI = state === 'RI';
    const t = D.totals(doc);
    const signedAt = sig && sig.signed_at ? new Date(sig.signed_at) : new Date();
    const deadline = longDate(addBusinessDays(signedAt, 3));
    const addr = (co.address || '').split('\n').join(', ');
    const job = (doc.job_site || doc.customer_address || '').split('\n').join(', ');
    const h = (s) => `<h3>${s}</h3>`;
    const p = (s) => `<p>${s}</p>`;
    const ul = (items) => `<ul>${items.filter(Boolean).map((i) => `<li>${i}</li>`).join('')}</ul>`;
    const b = [];

    const sched = D.scheduleAmounts(doc);
    const schedRows = sched.length
      ? sched.map((m, i) => `<tr><td>${esc(m.name || 'Payment ' + (i + 1))}</td><td>${dueWhen(m, i, sched.length)}</td><td class="n">${money(m.amount)}</td></tr>`).join('')
      : `<tr><td>Full contract price</td><td>At completion</td><td class="n">${money(t.total)}</td></tr>`;
    const first = sched[0];
    const second = sched.length > 1 && dueWhen(sched[1], 1, sched.length) === 'On the day work starts' ? sched[1] : null;

    b.push(`<div class="k-title"><h2>Home Improvement Contract</h2><p class="k-sub">${MA ? 'Massachusetts' : 'Rhode Island'} &middot; Contract number ${esc(doc.number)}${sig ? ` &middot; Signed ${esc(dateTime(sig.signed_at))}` : ''}</p></div>`);

    b.push(h('1. Parties') + p(`<b>Contractor:</b> ${esc(co.name)}, ${esc(addr)}. Phone ${esc(co.phone || '')}. Email ${esc(co.email || '')}.` +
      (MA ? `<br><b>Massachusetts Home Improvement Contractor (HIC) Registration No. ${esc(co.hic_no || '')}</b>${co.csl_no ? `. Construction Supervisor License (CSL) No. ${esc(co.csl_no)}` : ''}.` : '') +
      (RI ? `<br><b>Rhode Island Contractors' Registration and Licensing Board Registration No. ${esc(co.ri_reg_no || '')}</b>.` : '') +
      `<br><b>Salesperson:</b> ${esc(co.salesperson || 'None')}`) +
      p(`<b>Owner:</b> ${esc(doc.customer_name)}, ${esc(job)}.${doc.customer_phone ? ` Phone ${esc(doc.customer_phone)}.` : ''}${doc.customer_email ? ` Email ${esc(doc.customer_email)}.` : ''}`));

    b.push(h('2. Contract documents') + p('This contract is the complete agreement between Contractor and Owner. It is made up of:') +
      `<ol><li>this contract and its notices;</li><li>Estimate ${esc(doc.number)}, dated ${fmtDate(doc.issue_date)}, which describes the work, materials and price;</li><li>the payment schedule in section 5;</li><li>any change orders signed by both parties after today.</li></ol>` +
      p('No other promise, verbal or written, is part of this agreement.'));

    b.push(h('3. Scope of work and materials') + p(`Contractor will perform the work and supply the materials described in Estimate ${esc(doc.number)}, attached. Work or materials not listed in the estimate are not included. Optional items are included only if marked "included" on the signed estimate.`) +
      p('Where the estimate names a brand, grade or model, Contractor will use it or an equal product if it is unavailable, after telling Owner. Where Owner chooses finishes (tile, fixtures, paint colors), section 9 applies.'));

    b.push(h('4. Contract price') + p(`The total contract price is <b>${money(t.total)}</b>, including all finance charges. There are no finance charges.`));

    b.push(h('5. Payment schedule') + p('Owner will pay Contractor as follows:') +
      `<table class="k-tbl"><thead><tr><th>Payment</th><th>When it is due</th><th class="n">Amount</th></tr></thead><tbody>${schedRows}</tbody></table>` +
      (first && second ? p(`<b>Payments before and at the start of work.</b> Before any work starts, Owner pays only the ${esc((first.name || 'deposit').toLowerCase())} of <b>${money(first.amount)}</b>. The next payment, ${esc((second.name || 'payment 2').toLowerCase())} of <b>${money(second.amount)}</b>, is collected on the day work starts, once work has begun. The rest is due as shown above.`) : '') +
      ul([
        MA ? '<b>(MA)</b> Any deposit paid before work starts will not be more than one-third of the total contract price, or the actual cost of special-order or custom-made materials or equipment that must be ordered before work starts, whichever is greater.' : '',
        'Final payment is due when the work is complete.' + (MA ? ' Massachusetts law does not allow final payment to be demanded until the contract is completed to the satisfaction of all parties.' : ''),
        'This contract has no clause that makes the unpaid balance due early because Contractor feels insecure.'
      ]));

    const window_ = esc(co.start_window || '2 to 4 weeks after this contract is signed');
    const duration = esc(doc.duration_text || '');
    b.push(h('6. Schedule') +
      p(`<b>Start.</b> The start date is not fixed when this contract is signed. Contractor will schedule the start of work for approximately <b>${window_}</b>, and will confirm the start date with Owner in writing (by email or text message) at least 3 days before work begins. That written confirmation becomes the start date under this contract.`) +
      p(duration
        ? `<b>Projected duration.</b> Once started, the work is projected to take approximately <b>${duration}</b> to reach substantial completion. This is a projection, not a guaranteed completion date. Contractor will give Owner a projected completion date with the start date confirmation, and will update Owner in writing if it changes.`
        : `<b>Projected completion.</b> Contractor will give Owner a projected completion date, as a range, with the start date confirmation. It is a projection, not a guaranteed completion date, and Contractor will update Owner in writing if it changes.`) +
      p('The start date and projected completion move, without penalty to Contractor, for delays Contractor does not control, including: weather; inspection timing; material shortages or delivery delays; signed change orders; hidden conditions (section 8); Owner selections, decisions or payments made late; and the work area not being available.') +
      p('Work will not begin until both parties have signed this contract, Owner has received a copy, and any cancellation period in the notices below has ended, unless the work is an emergency.'));

    b.push(h('7. Changes to the work') + p('Any change to the work, price or schedule must be in a written change order signed by both parties before the changed work is done. Contractor will send change orders through Folio for Owner to approve and sign online. Verbal requests, by Owner or anyone else, are not binding and will not be performed until a change order is signed.'));

    b.push(h('8. Hidden or unforeseen conditions') + p('The price is based on conditions that could be seen when the estimate was prepared. If Contractor finds conditions that could not reasonably have been seen, Contractor will stop the affected work, tell Owner, and give Owner a change order for the extra cost and time. Examples include rot, mold, water or insect damage, structural problems, metal lath, out-of-code wiring or plumbing, and old work done improperly.') +
      p('Removing or handling asbestos, lead paint, mold or other hazardous materials is not included. If any is found, work in that area stops until it is handled by a licensed specialist at Owner\'s cost.'));

    b.push(h('9. Allowances, selections and Owner-supplied items') + ul([
      '<b>Allowances.</b> Where the estimate states an allowance (for example a materials allowance of $5,000), Owner pays the actual cost above the allowance through a change order, and receives a credit for any unused amount.',
      '<b>Selections.</b> Owner will make selections (tile, fixtures, colors) by the date Contractor asks. Late selections can delay the work and move the completion date.',
      '<b>Owner-supplied items.</b> Contractor installs items Owner supplies but does not warrant them. Owner is responsible for their correct type, quantity, condition and timely delivery. Extra labor caused by missing, damaged or wrong Owner-supplied items is billed through a change order.'
    ]));

    b.push(h('10. Owner responsibilities') + p('Owner will:') + ul([
      `give Contractor access to the work area during working hours, ${esc(co.work_hours || 'Monday to Friday, 7 AM to 5 PM')};`,
      'provide electricity and water at no charge;',
      'clear the work area of furniture, belongings and valuables before work starts;',
      'keep children and pets away from the work area;',
      'make decisions and answer questions within 2 business days, so the work is not held up.'
    ]));

    b.push(h('11. Late payment and stopping work') + ul([
      'A payment not made within 5 days of its due date is late. Late payments carry interest at 1.5% per month (18% per year), or the highest rate allowed by law if lower.',
      'If a payment is more than 7 days late, Contractor may stop work after giving Owner written notice. The completion date moves by the time work is stopped, plus reasonable time to return to the job.',
      MA ? '<b>(MA)</b> If Contractor has a reasonable concern about Owner\'s ability to pay, Contractor may require that the balance not yet due be placed in a joint escrow account before continuing. Money leaves that account only with both parties\' signatures.' : '',
      'Owner pays reasonable costs of collecting unpaid amounts, including attorney\'s fees, to the extent the law allows.'
    ]));

    b.push(h('12. Warranty') + p(`Contractor warrants its workmanship for <b>${esc(co.warranty_term || '1 year')}</b> from substantial completion. If a defect in Contractor's workmanship appears during that time, Owner will notify Contractor in writing, give access, and Contractor will repair it at no charge.`) +
      p('This warranty does not cover: normal wear; damage from misuse, neglect, accidents, settling or weather events; Owner-supplied items; work changed by others; or materials and appliances, which carry only their manufacturers\' warranties. Contractor passes on all manufacturers\' warranties to Owner.') +
      p('Nothing in this contract limits warranties or rights Owner has under state law, including the implied warranties of merchantability and fitness for a particular purpose.'));

    b.push(h('13. Insurance') + p(`Contractor carries general liability insurance of at least ${esc(co.insurance_amount || '')} per occurrence and workers' compensation insurance as state law requires.${RI ? ' <b>(RI)</b> Rhode Island requires at least $500,000 of general liability insurance.' : ''} Contractor will provide a certificate of insurance on request.`));

    b.push(h('14. Subcontractors') + p(`Contractor may use subcontractors. Contractor remains fully responsible for completing the work and for paying all subcontractors and suppliers it hires.${RI ? ' <b>(RI)</b> Contractor uses only subcontractors registered with the Contractors\' Registration and Licensing Board.' : ''}`));

    b.push(h('15. Cleanup and photos') + p('Contractor will keep the work area reasonably clean each day and remove its debris at the end of the job. Contractor may photograph the work for its records and portfolio, without showing Owner\'s name or address.' +
      (sig ? (sig.no_photos ? ' <b>Owner chose: no photos for portfolio use.</b>' : '') : ' Owner can opt out when signing.')));

    b.push(h('16. Ending the contract') + ul([
      '<b>By Owner</b> (after any cancellation period has ended): Owner may end the contract with written notice. Owner then pays for all work done to that date, all materials ordered that cannot be returned, any restocking fees, and costs Contractor has already committed to.',
      '<b>By Contractor:</b> Contractor may end the contract with written notice if Owner does not make a payment within 10 days of written notice that it is late, prevents Contractor from doing the work, or the site is unsafe and Owner does not fix it. Owner then pays as above.'
    ]));

    b.push(h('17. Disputes') + p(`The parties will first try to resolve any dispute by talking in good faith. This contract is governed by the law of ${MA ? 'Massachusetts' : 'Rhode Island'}.`) +
      (MA ? p('<b>(MA)</b> Owner has the right to start arbitration under Massachusetts General Laws chapter 142A as an alternative to court. Contractor\'s right to start arbitration exists only if both parties separately sign the optional arbitration agreement in the attachments.') : '') +
      (RI ? p('<b>(RI)</b> Owner may file a complaint with the Rhode Island Contractors\' Registration and Licensing Board or go to court.') : ''));

    b.push(h('18. Liens') + p(MA ? '<b>(MA)</b> This contract does not place a lien or security interest on Owner\'s home. Contractor keeps any rights the law gives for unpaid work.' : '<b>(RI)</b> See the Notice of Possible Mechanic\'s Lien in the attachments, which is part of this contract.'));

    b.push(h('19. Electronic signatures and copies') + p('Both parties agree to sign this contract electronically, and that electronic signatures are as binding as signatures on paper. Owner receives a complete signed copy immediately after signing, to view online and download as a PDF. Contractor keeps the other copy. Any change to this contract must be in writing and signed by both parties.'));

    if (co.contract_extra) b.push(h('20. Additional terms') + p(nl(co.contract_extra)));

    // Notices
    b.push(`<h3 class="k-sec">Notices</h3>` +
      (MA ? p('<b>Contractor registration.</b> All home improvement contractors and subcontractors shall be registered. Any inquiries about a contractor or subcontractor relating to registration should be directed to: Office of Consumer Affairs and Business Regulation, Home Improvement Contractor Program, 1 Federal Street, Suite 0720, Boston, MA 02110. Phone 617-973-8787 or 888-283-3757.') : '') +
      (RI ? p('<b>Contractor registration.</b> Owner can verify Contractor\'s registration at crb.ri.gov. Rhode Island Contractors\' Registration and Licensing Board, 560 Jefferson Boulevard, Warwick, RI 02886. Phone (401) 889-5555. Owner has received the Board\'s summary "What Homeowners Should Know" (attachment D).') : '') +
      p('<b>Warranties.</b> Owner\'s warranty rights are described in section 12. Owner\'s rights under state consumer protection laws cannot be waived by this contract.') +
      `<p class="k-big">YOU, THE BUYER, MAY CANCEL THIS TRANSACTION AT ANY TIME PRIOR TO MIDNIGHT OF THE THIRD BUSINESS DAY AFTER THE DATE OF THIS TRANSACTION. SEE THE ATTACHED NOTICE OF CANCELLATION FORM FOR AN EXPLANATION OF THIS RIGHT.</p>` +
      p('<b>No work before signing.</b> No work will begin until this contract is signed by both parties, Owner has received a copy, and the cancellation period has ended.') +
      `<p class="k-big">DO NOT SIGN THIS CONTRACT IF THERE ARE ANY BLANK SPACES.</p>`);

    // Signatures
    const sigImg = (src) => (src ? `<img class="k-sig" src="${src}" alt="Signature">` : '<div class="k-sig-blank">Signs below</div>');
    b.push(`<div class="k-signs">
      <div><div class="k-lab">Owner</div>${sig ? sigImg(sig.image) : sigImg(null)}<div class="k-line">${esc(sig ? sig.name : doc.customer_name)}</div>
        <div class="k-meta">${sig ? `Signed electronically ${esc(dateTime(sig.signed_at))}` : 'Not signed yet'}</div></div>
      <div><div class="k-lab">Contractor</div>${co.contractor_signature ? `<img class="k-sig" src="${co.contractor_signature}" alt="Contractor signature">` : sigImg(null)}<div class="k-line">${esc(co.signer_name || '')}, for ${esc(co.name)}</div>
        <div class="k-meta">${sig ? `Signed electronically ${esc(dateTime(sig.signed_at))}` : 'Applied when Owner signs'}</div></div>
    </div>` + (sig ? `<p class="k-meta">Owner agreed to this contract, the attached estimate and the notices. Signing record: ${esc(sig.ua ? sig.ua.slice(0, 110) : 'device not recorded')}${sig.ip ? `, IP ${esc(sig.ip)}` : ''}.</p>` : ''));

    // Attachments
    b.push(`<h3 class="k-sec">Attachment A. Notice of Cancellation</h3>` +
      p(`<b>${esc(fmtDate(signedAt.toISOString()))}</b> (date of transaction)`) +
      p('You may CANCEL this transaction, without any Penalty or Obligation, within THREE BUSINESS DAYS from the above date.') +
      p('If you cancel, any property traded in, any payments made by you under the contract or sale, and any negotiable instrument executed by you will be returned within TEN BUSINESS DAYS following receipt by the seller of your cancellation notice, and any security interest arising out of the transaction will be cancelled.') +
      p('If you cancel, you must make available to the seller at your residence, in substantially as good condition as when received, any goods delivered to you under this contract or sale; or you may, if you wish, comply with the instructions of the seller regarding the return shipment of the goods at the seller\'s expense and risk.') +
      p('If you do make the goods available to the seller and the seller does not pick them up within twenty days of the date of your Notice of Cancellation, you may retain or dispose of the goods without any further obligation. If you fail to make the goods available to the seller, or if you agree to return the goods to the seller and fail to do so, then you remain liable for performance of all obligations under the contract.') +
      p(`To cancel this transaction, mail or deliver a signed and dated copy of this Cancellation Notice or any other written notice to ${esc(co.name)}, at ${esc(addr)}, NOT LATER THAN MIDNIGHT OF <b>${esc(deadline)}</b>.${co.email ? ` You may also email it to ${esc(co.email)}.` : ''}`) +
      p('I HEREBY CANCEL THIS TRANSACTION.') + p('Buyer\'s signature: ______________________ &nbsp; Date: __________'));

    if (RI) {
      b.push(`<h3 class="k-sec">Attachment B. Notice of Cancellation (owner 60 or older)</h3>` +
        p(`<b>${esc(fmtDate(signedAt.toISOString()))}</b> (date of transaction)`) +
        p(`You may cancel this agreement, without any penalty or obligation, within three (3) business days from the above date. If you cancel, your cancellation notice must state that you do not wish to be bound by the agreement and mailed by registered or certified mail not later than midnight three (3) days following the consumer's signing the agreement, excluding Sunday and any holiday on which regular mail deliveries are not made. All cancellations must be mailed to: ${esc(co.name)}, ${esc(addr)}.`));
      b.push(`<h3 class="k-sec">Attachment C. Notice of Possible Mechanic's Lien</h3>` +
        `<div class="k-box"><p><b>NOTICE OF POSSIBLE MECHANIC'S LIEN</b></p>` +
        p(`To: ${esc(doc.customer_name)}`) +
        p(`The undersigned is about to perform work and/or furnish materials for the construction, erection, alterations, or repair upon the land at ${esc(job)} under contract with you. This is a notice that the undersigned and any other persons who provide labor and materials for the improvement under contract with the undersigned may file a mechanic's lien upon the land in the event of nonpayment to them. It is your responsibility to assure yourself that those other persons under contract with the undersigned receive payment for their work performed and materials furnished for the construction, erection, alteration or repair upon the land.`) + '</div>');
      b.push(`<h3 class="k-sec">Attachment D. What Homeowners Should Know</h3>` +
        p('The Rhode Island Contractors\' Registration and Licensing Board\'s summary of homeowner and contractor rights, provided as required by law: <a href="https://crb.ri.gov/sites/g/files/xkgbur711/files/2024-01/What%20Homeowners%20Should%20Know_03.08.2023.pdf" target="_blank" rel="noopener">crb.ri.gov, What Homeowners Should Know</a>.'));
    }

    if (MA && co.arbitration_enabled !== false) {
      b.push(`<h3 class="k-sec">Attachment E. Contractor arbitration (optional, signed separately)</h3>` +
        p('The contractor and the homeowner hereby mutually agree in advance that in the event the contractor has a dispute concerning this contract, the contractor may submit the dispute to a private arbitration firm which has been approved by the Secretary of the Executive Office of Consumer Affairs and Business Regulation and the consumer shall be required to submit to such arbitration as provided in Massachusetts General Laws, chapter 142A.') +
        (sig && sig.arbitration_image
          ? `<div class="k-signs"><div><div class="k-lab">Homeowner</div>${sigImg(sig.arbitration_image)}<div class="k-line">${esc(sig.arbitration_name || sig.name)}</div><div class="k-meta">Signed ${esc(dateTime(sig.signed_at))}</div></div>
             <div><div class="k-lab">Contractor</div>${co.contractor_signature ? `<img class="k-sig" src="${co.contractor_signature}" alt="">` : ''}<div class="k-line">${esc(co.signer_name || '')}</div><div class="k-meta">Signed ${esc(dateTime(sig.signed_at))}</div></div></div>`
          : p(sig ? '<b>Not signed by the homeowner.</b> This optional agreement does not apply.' : '<i>Optional. The homeowner may sign this separately when accepting.</i>')) +
        p('NOTICE: The signatures of the parties above apply only to the agreement of the parties to alternative dispute resolution initiated by the contractor. The homeowner may initiate alternative dispute resolution even where this section is not separately signed by the parties.'));
    }
    return b;
  }

  function render(ctx) {
    return `<article class="paper contract-paper"><div class="p-band"></div>${blocks(ctx).map((x) => `<div class="k-blk">${x}</div>`).join('')}</article>`;
  }

  // For a signed contract use what was saved at signing, so later profile edits never change it.
  function ctxFor(doc, co) {
    const sig = doc.signature || null;
    if (sig && sig.company && sig.document) return { doc: { ...sig.document, number: doc.number }, co: { ...sig.company, logo: sig.company.logo || co.logo }, sig };
    return { doc, co, sig };
  }

  // ---------------- PDF pages ----------------
  const BODY_MAX = 1056 - 52 - 70 - 34 - 16;
  async function pages(ctx) {
    const list = blocks(ctx);
    const brand = /^#[0-9a-f]{3,8}$/i.test(ctx.co.color || '') ? ctx.co.color : '#1F4E46';
    const host = document.createElement('div');
    host.className = 'export-host';
    host.innerHTML = `<div class="pg kpg" style="--brand:${brand}"><div class="pg-body"></div></div>`;
    document.body.appendChild(host);
    const mz = host.querySelector('.pg-body');
    const H = (html) => { mz.innerHTML = `<div class="k-blk">${html}</div>`; return mz.firstElementChild.getBoundingClientRect().height; };
    const head = `<div class="pg-cont-head"><span class="pg-co">${esc(ctx.co.name || '')}</span><span>Contract ${esc(ctx.doc.number)}</span></div>`;
    try {
      const hHead = H(head);
      const out = [];
      let cur = { html: [head], h: hHead };
      const parts = [];
      // Split long blocks (sections with several paragraphs) into their child pieces so pages fill well.
      list.forEach((bl) => {
        mz.innerHTML = `<div class="k-blk">${bl}</div>`;
        const kids = [...mz.firstElementChild.children].map((k) => k.outerHTML);
        if (kids.length < 2) { parts.push(bl); return; }
        // Keep each heading with the piece that follows it, so a heading never ends a page on its own.
        for (let i = 0; i < kids.length; i++) {
          if (/^<h[23]/.test(kids[i]) && i + 1 < kids.length) { parts.push(kids[i] + kids[i + 1]); i++; } else parts.push(kids[i]);
        }
      });
      parts.forEach((x) => {
        const hh = H(x);
        if (cur.h + hh > BODY_MAX && cur.html.length > 1) { out.push(cur); cur = { html: [head], h: hHead }; }
        cur.html.push(`<div class="k-blk">${x}</div>`); cur.h += hh;
      });
      out.push(cur);
      return out.map((pg, n) => `<div class="pg kpg" style="--brand:${brand}"><div class="p-band"></div><div class="pg-body">${pg.html.join('')}</div>
        <div class="pg-foot"><span>${esc(ctx.co.name || '')}</span><span>Contract ${esc(ctx.doc.number)}</span><span>Contract page ${n + 1} of ${out.length}</span></div></div>`);
    } finally { host.remove(); }
  }

  // Signed contract PDF = contract pages, then the estimate it refers to.
  async function toPdf(doc, co) {
    if (!window.jspdf || !window.html2canvas) throw new Error('The PDF library did not load. Check your connection and refresh.');
    const ctx = ctxFor(doc, co);
    const all = [...(await pages(ctx)), ...(await D.buildPages({ ...ctx.doc, signature: null }, ctx.co, []))];
    const pdf = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    for (let i = 0; i < all.length; i++) {
      const c = await D.pageCanvas(all[i]);
      if (i) pdf.addPage();
      pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pw, ph);
    }
    return pdf;
  }

  // ---------------- Signature pad ----------------
  function pad(canvas, onChange) {
    const ctx = canvas.getContext('2d');
    let drawing = false, last = null, dirty = false;
    const fit = () => {
      const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      const keep = dirty ? canvas.toDataURL() : null;
      canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#13233A';
      if (keep) { const im = new Image(); im.onload = () => ctx.drawImage(im, 0, 0, r.width, r.height); im.src = keep; }
    };
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); drawing = true; last = pos(e); ctx.beginPath(); ctx.arc(last.x, last.y, 1.1, 0, Math.PI * 2); ctx.fillStyle = '#13233A'; ctx.fill(); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const pt = pos(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(pt.x, pt.y); ctx.stroke();
      last = pt;
      if (!dirty) { dirty = true; if (onChange) onChange(true); }
    });
    const end = () => { drawing = false; };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    fit();
    window.addEventListener('resize', () => { if (canvas.isConnected) fit(); });
    return {
      isEmpty: () => !dirty,
      clear: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; if (onChange) onChange(false); },
      // Trimmed PNG of just the ink.
      image: () => {
        const w = canvas.width, hgt = canvas.height, px = ctx.getImageData(0, 0, w, hgt).data;
        let x0 = w, y0 = hgt, x1 = 0, y1 = 0;
        for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 <= x0) return '';
        const padPx = 8, c = document.createElement('canvas');
        const cw = x1 - x0 + padPx * 2, chh = y1 - y0 + padPx * 2;
        const s = Math.min(1, 600 / cw);
        c.width = Math.round(cw * s); c.height = Math.round(chh * s);
        c.getContext('2d').drawImage(canvas, x0 - padPx, y0 - padPx, cw, chh, 0, 0, c.width, c.height);
        return c.toDataURL('image/png');
      }
    };
  }

  window.Contract = { stateOf, contractState, issues, blocks, render, ctxFor, pages, toPdf, pad, addBusinessDays };
})();

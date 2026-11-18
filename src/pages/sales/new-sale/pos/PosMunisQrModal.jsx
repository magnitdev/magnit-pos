import { useEffect, useRef, useState } from 'react'
import { QRCodeCanvas } from 'qrcode.react'
import { CheckCircle2 } from 'lucide-react'
import { get } from 'lodash'
import { requests } from '@utils/requests'
import thousandDivider from '@utils/thousandDivider'
import { mertechShowQrOnDevice, mertechShowPaid, mertechClearScreen } from '@utils/mertechDisplay'
import './PosLayout.css'

const POLL_INTERVAL_MS = 3000
// How long the paid tick stays on the cashier's screen before the sale is
// finalized, and on the customer's display before it is blanked.
const PAID_HOLD_MS = 1200
const PAID_DEVICE_MS = 4000

/**
 * PosMunisQrModal
 *
 * Munis (QR Online) payment flow:
 *  1. On open, generate a per-sale dynamic QR. The server returns the bill_number
 *     (the sale's sale_number) the payment must be looked up by.
 *  2. Render the QR for the customer to scan and pay.
 *  3. Poll payment status by that bill_number until it lands (Munis code === 0).
 *  4. Once paid, call onPaid() which finalizes the sale (server re-verifies).
 *
 * While the QR is live the server locks the sale's cart, so Cancel must go
 * through the server (it unlocks the cart). A QR the customer has already paid
 * is not cancelled silently: the cashier is shown the payment and has to
 * confirm. Money that arrived at a different amount than the QR asked for
 * (the payer's app lets them edit it) is shown as such and never finalized.
 */
function PosMunisQrModal({ open, saleId, amount, otherAmount, onPaid, onCancel, t }) {
  const [status, setStatus] = useState('loading') // loading | waiting | paid | mismatch | error
  const [mismatch, setMismatch] = useState(null) // { paid, expected } when the money differs
  const [confirmForce, setConfirmForce] = useState(false) // cancel refused: already paid / unverifiable
  const [cancelling, setCancelling] = useState(false)
  const [qr, setQr] = useState('')
  const [billNumber, setBillNumber] = useState('') // Munis receipt/bill number to poll with
  const [errMsg, setErrMsg] = useState('')
  const [retryNonce, setRetryNonce] = useState(0)
  const paidHandledRef = useRef(false)
  const deviceShowingRef = useRef('none') // 'none' | 'qr' | 'paid' — what the customer display holds
  const deviceClearTimerRef = useRef(null)
  const onPaidRef = useRef(onPaid)

  // Track the latest onPaid without making it an effect dependency: PosApp
  // redefines it on every render, and the paid effect below must not be torn
  // down and restarted in the middle of its hold.
  useEffect(() => {
    onPaidRef.current = onPaid
  })

  // Generate the dynamic QR when the modal opens (or on retry)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    paidHandledRef.current = false
    setStatus('loading')
    setQr('')
    setBillNumber('')
    setErrMsg('')
    setMismatch(null)
    setConfirmForce(false)

    requests
      .generateMunisQr({ sale_id: saleId, amount: Number(amount), other_amount: Number(otherAmount || 0) })
      .then((res) => {
        if (cancelled) return
        const qrValue = get(res, 'data.data.qr', '')
        const bill = get(res, 'data.data.bill_number', '')
        if (!qrValue || !bill) {
          setStatus('error')
          setErrMsg(t('pos.munis.generate_failed'))
          return
        }
        setQr(qrValue)
        setBillNumber(String(bill))
        setStatus('waiting')
      })
      .catch((e) => {
        if (cancelled) return
        setStatus('error')
        setErrMsg(munisErrorText(e))
      })

    return () => {
      cancelled = true
    }
  }, [open, saleId, amount, otherAmount, retryNonce])

  // The modal stays mounted between sales, so clear the finished sale's state
  // on close — a leftover status === 'paid' would otherwise auto-fire onPaid()
  // the moment the modal reopens for the next sale (the paid-finalize effect
  // re-runs on onPaid identity changes and sees the stale status before the
  // new QR's setStatus lands), finalizing it with no QR shown and no payment.
  useEffect(() => {
    if (open) return
    setStatus('loading')
    setQr('')
    setBillNumber('')
    setErrMsg('')
    setMismatch(null)
    setConfirmForce(false)
    setCancelling(false)
  }, [open])

  // Poll for payment while waiting
  useEffect(() => {
    if (!open || status !== 'waiting' || !billNumber) return
    let stopped = false

    const poll = async () => {
      try {
        const res = await requests.getMunisPayment({ bill_number: billNumber })
        const code = get(res, 'data.data.code')
        if (stopped || code !== 0) return
        // amount_matches is absent for a QR the server has no record of
        // (issued before it kept them) — only an explicit false stops here.
        if (get(res, 'data.data.amount_matches') === false) {
          setMismatch({
            paid: Number(get(res, 'data.data.paid_amount', 0)),
            expected: Number(get(res, 'data.data.expected_amount', 0)),
          })
          setStatus('mismatch')
          return
        }
        setStatus('paid')
      } catch {
        // ignore transient poll errors; keep polling
      }
    }

    const interval = setInterval(poll, POLL_INTERVAL_MS)
    poll() // immediate first check
    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [open, status, billNumber])

  // The Mertech customer display mirrors this modal: the QR while the modal
  // shows one, then the paid tick when the payment lands, then blank.
  //
  // Best effort throughout. These calls are fire-and-forget and never awaited,
  // so a missing or broken display cannot delay or interrupt the payment (see
  // @utils/mertechDisplay).
  const qrOnScreen = open && status === 'waiting' && Boolean(qr)
  const deviceIntent = !open ? 'blank' : status === 'paid' ? 'paid' : qrOnScreen ? 'qr' : 'blank'

  useEffect(() => {
    const cancelClearTimer = () => {
      if (deviceClearTimerRef.current) {
        clearTimeout(deviceClearTimerRef.current)
        deviceClearTimerRef.current = null
      }
    }

    if (deviceIntent === 'qr') {
      cancelClearTimer()
      deviceShowingRef.current = 'qr'
      mertechShowQrOnDevice(qr)
      return
    }

    if (deviceIntent === 'paid') {
      if (deviceShowingRef.current === 'paid') return // already sent for this sale
      cancelClearTimer()
      deviceShowingRef.current = 'paid'
      mertechShowPaid()
      // The device holds the tick until it is told otherwise, and this modal
      // closes well before then — so the blank is scheduled here rather than
      // driven by the intent going back to 'blank' below.
      deviceClearTimerRef.current = setTimeout(() => {
        deviceClearTimerRef.current = null
        deviceShowingRef.current = 'none'
        mertechClearScreen()
      }, PAID_DEVICE_MS)
      return
    }

    // Only a QR is blanked eagerly. A tick is left to its own timer, so closing
    // the modal doesn't wipe the confirmation the customer was just shown.
    if (deviceShowingRef.current === 'qr') {
      deviceShowingRef.current = 'none'
      mertechClearScreen()
    }
  }, [deviceIntent, qr])

  // Unmounted with something still on the display (route change, hard close).
  useEffect(
    () => () => {
      if (deviceClearTimerRef.current) clearTimeout(deviceClearTimerRef.current)
      if (deviceShowingRef.current !== 'none') {
        deviceShowingRef.current = 'none'
        mertechClearScreen()
      }
    },
    [],
  )

  // Once paid, hold the tick on screen for a beat so the cashier actually sees
  // it, then finalize the sale (server re-verifies). Guard against double-calls.
  useEffect(() => {
    if (!open || status !== 'paid' || paidHandledRef.current) return
    paidHandledRef.current = true

    let fired = false
    const finalize = () => {
      if (fired) return
      fired = true
      onPaidRef.current?.()
    }

    // finalize() also runs on cleanup, never just the timer: the customer has
    // already paid, so finalization must not be skipped because the effect was
    // torn down early (unmount, or the modal closed from elsewhere).
    const timer = setTimeout(finalize, PAID_HOLD_MS)
    return () => {
      clearTimeout(timer)
      finalize()
    }
  }, [open, status])

  function munisErrorText(e) {
    const key = get(e, 'response.data.data')
    const known = {
      'munis.amount.stale': 'pos.munis.amount_stale',
      'munis.qr.paid': 'pos.munis.qr_paid',
      'munis.amount.invalid': 'pos.munis.amount_invalid',
      'munis.unavailable': 'pos.munis.unavailable',
    }
    if (known[key]) return t(known[key])
    return key || get(e, 'response.data.message') || t('pos.munis.generate_failed')
  }

  // Cancel retires the QR on the server, which unlocks the cart. If Munis says
  // the customer has already paid (or can't be asked), the cashier is asked to
  // confirm before the payment is walked away from.
  const handleCancel = async (force = false) => {
    if (cancelling) return
    setCancelling(true)
    try {
      await requests.cancelMunisQr({ sale_id: saleId, force })
      onCancel()
    } catch (e) {
      const key = get(e, 'response.data.data')
      if (!force && (key === 'munis.qr.paid' || key === 'munis.unavailable')) {
        setConfirmForce(true)
        setErrMsg(munisErrorText(e))
      } else {
        setErrMsg(munisErrorText(e))
        setStatus('error')
      }
    } finally {
      setCancelling(false)
    }
  }

  if (!open) return null

  return (
    <div className='pos-modal-overlay' role='dialog' aria-modal='true'>
      <div className='pos-app-scan-modal'>
        <div className='pos-app-scan-title'>UzQR</div>

        <div className='pos-app-scan-payment-row'>
          <span className='pos-app-scan-payment-label'>{t('pos.total_compact')}</span>
          <span className='pos-app-scan-payment-name'>{thousandDivider(Number(amount), t('pos.currency_short'))}</span>
        </div>

        {status === 'loading' && (
          <div className='pos-app-scan-desc'>{t('pos.munis.generating')}</div>
        )}

        {status === 'waiting' && (
          <>
            <div className='pos-app-scan-desc'>
              {t('pos.munis.scan_to_pay')}
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                padding: 12,
                background: '#fff',
                borderRadius: 12,
                margin: '10px auto',
              }}
            >
              <QRCodeCanvas value={qr} size={240} includeMargin />
            </div>
            <div className='pos-app-scan-desc' style={{ fontSize: 13, opacity: 0.7 }}>
              {t('pos.munis.waiting')}
            </div>
          </>
        )}

        {status === 'paid' && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              padding: '20px 0',
              color: '#1e9e52',
            }}
          >
            <CheckCircle2 size={72} strokeWidth={2.5} />
            <div style={{ fontSize: 18, fontWeight: 700 }}>{t('pos.munis.paid')}</div>
          </div>
        )}

        {status === 'mismatch' && mismatch && (
          <div className='pos-app-scan-desc' style={{ color: '#e23a32' }}>
            {t('pos.munis.amount_mismatch', {
              paid: thousandDivider(mismatch.paid, t('pos.currency_short')),
              expected: thousandDivider(mismatch.expected, t('pos.currency_short')),
            })}
          </div>
        )}

        {status === 'error' && !confirmForce && <div className='pos-app-scan-desc' style={{ color: '#e23a32' }}>{errMsg}</div>}

        {confirmForce && (
          <div className='pos-app-scan-desc' style={{ color: '#e23a32' }}>
            {errMsg} {t('pos.munis.cancel_anyway_hint')}
          </div>
        )}

        <div className='pos-security-actions'>
          <button type='button' onClick={() => handleCancel(false)} disabled={cancelling} className='pos-security-btn-cancel'>
            {t('pos.security.cancel')}
          </button>
          {confirmForce && (
            <button type='button' onClick={() => handleCancel(true)} disabled={cancelling} className='pos-app-scan-btn-confirm'>
              {t('pos.munis.cancel_anyway')}
            </button>
          )}
          {status === 'error' && !confirmForce && (
            <button
              type='button'
              onClick={() => setRetryNonce((n) => n + 1)}
              className='pos-app-scan-btn-confirm'
            >
              {t('retry')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default PosMunisQrModal

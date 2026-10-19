export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Zərərli SQL qoruması (SELECT olmayan, qadağan söz, ikinci sorğu). Admin marşrutlarında istifadəçi girişi olduqda pozuntu sayılır.
export class GuardError extends HttpError {}

// Xətanı "təhlükəsizlik pozuntusu" kimi işarələyir. api.js-də wrap() bunu tutub istifadəçini bloklayır.
export function markViolation(err, kind, what, sample) {
  err.violation = { kind, what, sample };
  return err;
}

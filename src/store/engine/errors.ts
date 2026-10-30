/** Using the outer handle inside a transaction, or a synchronous handle while another flow holds one. Both engines. */
export class TxMisuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxMisuseError';
  }
}

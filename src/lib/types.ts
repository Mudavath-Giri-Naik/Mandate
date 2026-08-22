export type ProductStatus = 'available' | 'reserved' | 'sold_out';

export type OrderStatus =
  | 'created'
  | 'reserved'
  | 'paid'
  | 'failed'
  | 'cancelled';

export interface Product {
  id: string;
  name: string;
  description: string | null;
  /** Paise. ₹499 → 49900. */
  price: number;
  size: string | null;
  color: string | null;
  image_url: string | null;
  stock_count: number;
  status: ProductStatus;
  created_at: string;
}

export interface Order {
  id: string;
  product_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  /** Units ordered. 1 for the browser checkout. */
  quantity: number;
  /** Paise, per unit, at the time of ordering. */
  unit_price: number | null;
  /** Whole percent, 0-100. */
  discount_percent: number;
  /** Paise. unit_price * quantity, less the discount. */
  amount: number;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
}

/** Order joined with its product, as returned by GET /api/orders/:id. */
export interface OrderWithProduct extends Order {
  product: Pick<Product, 'id' | 'name' | 'size' | 'color' | 'image_url'> | null;
}

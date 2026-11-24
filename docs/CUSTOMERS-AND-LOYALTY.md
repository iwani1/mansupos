# Customers and loyalty points

Shop customers can collect points on retail sales.

## The rules

- **Earn:** 1 point for every GH₵1 paid, counted when the sale is paid. Points are earned on what the customer actually paid, after any points discount.
- **Use:** in steps of 100 points; 100 points = GH₵1.00 off. Points can pay for all but GH₵1.00 of a sale.
- **Wholesale** sales do not earn or use points.

## At the till

1. Tap **Walk-in customer** in the cart.
2. Search by phone number (for example `0244`) or name, or **Add a new customer** with their phone and name. Email is optional. Ask the customer before saving their details.
3. To use points, choose an amount under **Use points**. The discount shows in the cart total.
4. Prepare the order and take payment as usual. The receipt shows the points used, earned and the new balance.

The customer's name and phone go on the WooCommerce order. A points discount appears on that order as a "Loyalty points (…)" fee line with a negative amount.

## What happens when…

| Situation | Points |
| --- | --- |
| Order prepared with points | Taken straight away, so the same points cannot be spent twice |
| Sale cancelled or failed | Points used are given back |
| Sale paid | Points earned are added |
| Items returned (Customer returns) | The refund is the price the customer actually paid (shared out if points were used); the points earned on the refunded amount are taken back |
| Refund made directly in WooCommerce | Points are not changed: the owner adjusts them by hand |

A balance never goes below zero. If a customer has already spent the points a return would take back, only what is left is taken.

## Customers page (owner and manager)

**Operations → Customers → Loyalty customers** lists every customer with points, visits, total spent and last visit. Open a customer to see their purchases and full points history, and edit their details.

Only the **owner** can change points by hand: enter a number (a minus sign removes points) and a reason. Use it for a paper loyalty card, a goodwill gesture or a correction. Every change is kept with the owner's name.

Customers cannot be deleted, and the points history cannot be edited.

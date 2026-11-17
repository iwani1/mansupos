# Adding and editing products from the POS

Owners and managers can add new products, with photos, sizes and colours, and edit existing ones from **Catalogue → Products**. New products are **published straight away**: they appear on the website and in the POS register at the same time.

## Add a product

1. Go to **Catalogue → Products** and click **Add product**.
2. **Photos:**
   - **Take photo** opens the tablet or phone camera; **Choose photos** picks from the gallery. You can add up to 12.
   - The first photo is the main one on the website. Tap the star on another photo to make it the main one, or ✕ to remove it.
   - Photos are resized automatically before upload.
3. **Details:**
   - Name.
   - Categories: choose existing ones, or type a new category.
   - Description: leave an empty line between paragraphs.
   - Optional product SKU, e.g. `AMARA`.
4. **Sizes and colours** (this is the default):
   - The **Size** and **Colour** boxes are already there. Tap the quick-add values (S, M, L / Black, Red…) or type your own and press Enter.
   - Use **Add another option** for a third one, such as Length.
   - The table lists every combination, e.g. *M / Black*. Fill **Price for all**, **Sale for all** and **Stock for each new**, then press **Apply to all**. Change single rows if a size or colour costs more.
   - **Fill SKUs** creates SKUs such as `AMARA-M-BLAC` for empty rows.
   - Untick **Sell** for combinations you don't have.
   - **Photo** chooses which photo shows for that combination, e.g. the emerald photo for the emerald rows.
5. For a **single item** (no sizes or colours), choose **Single item** and enter the price, an optional sale price and the starting stock.
6. Click **Publish product**. The product is live on the website and ready to sell at the till.

## Edit a product

Click **Edit** under the product's name in **Products**. You can change:
- the name, description, categories and photos;
- prices and sale prices;
- SKUs;
- which photo each size or colour uses;
- new sizes or colours: add a value and the new combinations appear with **Sell** ticked. Give them a price and starting stock.

Some changes work differently:
- **Unticking an existing combination** hides it from sale on the website and in the POS. It isn't deleted, so sales history stays intact. Tick it again to bring it back.
- **Stock of existing sizes and colours** is changed in **Stock control** (Receive / Remove / Count), so every stock change has a reason and appears in the history. The editor only sets stock for new combinations.
- A product can't be switched between "single item" and "sizes / colours". Create a new product instead.
- If someone changed the product on the website while you had it open, saving is refused. Close it and open it again.

## Safety

- Saving twice (double-tap, poor connection) never publishes two copies. If the website didn't answer, the POS asks you to check **Products** before saving again.
- A duplicate SKU is explained ("WooCommerce: Invalid or duplicated SKU."). Fix it and save again.
- If some sizes or colours could not be saved, you are told which. If none could, the product is hidden (draft) until fixed with **Edit**.
- Every product added or edited is recorded in the Audit log (`product.created`, `product.updated`), with who did it and when.
- Sizes and colours use your store's existing **Size** and **Color** attributes when they exist, so website filters keep working. New values (e.g. a new size) are added to them.

## Switching it on (live trading service)

Two settings in `/etc/mansu-pos-live-trading/pos.env`:

1. `POS_PRODUCT_WRITES_APPROVED=true`: turns on adding and editing products.
2. For photos, a WordPress Application Password:
   - In WordPress, open **Users → Profile** of a user who may upload files (Shop Manager or Administrator). Under **Application Passwords**, type the name "Mansu POS" and click **Add New Application Password**.
   - Copy the 24-character password it shows; it is shown only once.
   - Put these two lines in the settings file:
     ```
     POS_WP_MEDIA_USER=the-wordpress-username
     POS_WP_MEDIA_APP_PASSWORD=abcd efgh ijkl mnop qrst uvwx
     ```
     Never paste the password into chat or email.

Then restart: `systemctl restart mansu-pos-live-trading`.

Without the Application Password, products can still be added and edited, but the photo buttons are hidden and a notice explains why. To revoke the POS's photo access at any time, delete that Application Password in WordPress.

The WooCommerce API key the POS already uses for sales (Read/Write) is enough for creating and editing products.

In **demo** mode everything works with practice data. Products you add are saved in the demo workspace only. The ten sample products can't be edited; add your own to practise.

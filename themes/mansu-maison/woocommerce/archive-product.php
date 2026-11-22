<?php
/**
 * Shop, category, tag and product-search listings.
 *
 * Overrides WooCommerce's archive-product.php to add category buttons, the
 * sticky toolbar, removable filter chips and the filter drawer. Products are
 * WooCommerce's main query, rendered on the server.
 *
 * @see     https://woocommerce.com/document/template-structure/
 * @package Mansu_Maison
 * @version 8.6.0
 */

defined( 'ABSPATH' ) || exit;

get_header( 'shop' );

/* We print the result count and sorting in our own toolbar. */
remove_action( 'woocommerce_before_shop_loop', 'woocommerce_result_count', 20 );
remove_action( 'woocommerce_before_shop_loop', 'woocommerce_catalog_ordering', 30 );

do_action( 'woocommerce_before_main_content' );

$current = get_queried_object();
$shop    = wc_get_page_permalink( 'shop' );
$n       = mansu_active_filter_count();
?>
<header class="shop-head">
	<div class="rule" aria-hidden="true"></div>
	<?php if ( apply_filters( 'woocommerce_show_page_title', true ) ) : ?>
		<h1 class="page-title">
		<?php
		if ( is_search() ) {
			/* translators: %s: search phrase */
			printf( esc_html__( 'Results for “%s”', 'mansu-maison' ), esc_html( get_search_query() ) );
		} else {
			woocommerce_page_title();
		}
		?>
		</h1>
	<?php endif; ?>
	<?php do_action( 'woocommerce_archive_description' ); ?>
</header>

<?php if ( mansu_featured_cats() ) : ?>
<nav class="pills" aria-label="<?php esc_attr_e( 'Categories', 'mansu-maison' ); ?>">
	<a class="pill" href="<?php echo esc_url( $shop ); ?>"<?php echo is_shop() && ! is_search() ? ' aria-current="page"' : ''; ?>><?php esc_html_e( 'All', 'mansu-maison' ); ?></a>
	<?php foreach ( mansu_featured_cats() as $t ) : ?>
		<a class="pill" href="<?php echo esc_url( get_term_link( $t ) ); ?>"<?php echo ( $current instanceof WP_Term && $current->term_id === $t->term_id ) ? ' aria-current="page"' : ''; ?>><?php echo esc_html( $t->name ); ?></a>
	<?php endforeach; ?>
</nav>
<?php endif; ?>

<?php if ( woocommerce_product_loop() ) : ?>
	<div class="toolbar">
		<?php woocommerce_result_count(); ?>
		<div class="tb-right">
			<?php woocommerce_catalog_ordering(); ?>
			<button class="btn-ghost sm" type="button" data-open="filterD" aria-controls="filterD">
				<?php esc_html_e( 'Filter', 'mansu-maison' ); ?><?php echo $n ? ' (' . (int) $n . ')' : ''; ?>
			</button>
		</div>
	</div>
	<?php mansu_active_chips(); ?>
	<?php
	do_action( 'woocommerce_before_shop_loop' );
	woocommerce_product_loop_start();
	if ( wc_get_loop_prop( 'total' ) ) {
		while ( have_posts() ) {
			the_post();
			do_action( 'woocommerce_shop_loop' );
			wc_get_template_part( 'content', 'product' );
		}
	}
	woocommerce_product_loop_end();
	do_action( 'woocommerce_after_shop_loop' );
	?>
<?php else : ?>
	<?php mansu_active_chips(); ?>
	<div class="empty">
		<h2><?php esc_html_e( 'Nothing matches that yet', 'mansu-maison' ); ?></h2>
		<p>
			<?php esc_html_e( 'Try removing a filter or a word from your search. New pieces arrive every week, and we can check the showroom for you.', 'mansu-maison' ); ?>
		</p>
		<p class="ctas">
			<a class="btn-primary" href="<?php echo esc_url( $shop ); ?>"><?php esc_html_e( 'See all styles', 'mansu-maison' ); ?></a>
			<a class="btn-ghost" href="<?php echo esc_url( mansu_wa_link() ); ?>" target="_blank" rel="noopener"><?php esc_html_e( 'Ask on WhatsApp', 'mansu-maison' ); ?></a>
		</p>
		<?php do_action( 'woocommerce_no_products_found' ); ?>
	</div>
<?php endif; ?>

<?php do_action( 'woocommerce_after_main_content' ); ?>

<dialog class="side" id="filterD" aria-labelledby="fH">
	<div class="side-head"><h2 id="fH"><?php esc_html_e( 'Filter', 'mansu-maison' ); ?></h2><button class="icon-btn" type="button" data-close aria-label="<?php esc_attr_e( 'Close filters', 'mansu-maison' ); ?>"><?php echo mansu_icon( 'close' ); // phpcs:ignore WordPress.Security.EscapeOutput ?></button></div>
	<div class="side-body"><?php mansu_filter_form(); ?></div>
	<div class="side-foot">
		<button class="btn-primary" type="submit" form="filterForm"><?php esc_html_e( 'Show results', 'mansu-maison' ); ?></button>
		<a class="btn-ghost" href="<?php echo esc_url( mansu_listing_url( get_search_query() ) ); ?>"><?php esc_html_e( 'Clear all', 'mansu-maison' ); ?></a>
	</div>
</dialog>

<?php
get_footer( 'shop' );

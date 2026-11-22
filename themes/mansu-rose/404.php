<?php
/**
 * Not found: search and a way back into the shop.
 *
 * @package Mansu_Rose
 */

defined( 'ABSPATH' ) || exit;
get_header();
?>
<main id="main" class="wrap page-main">
	<div class="empty">
		<p class="eyebrow">404</p>
		<h1 class="page-title"><?php esc_html_e( 'This page has moved or sold out', 'mansu-rose' ); ?></h1>
		<p><?php esc_html_e( 'Search for the style you want, or browse what is in the showroom now.', 'mansu-rose' ); ?></p>
		<?php get_search_form(); ?>
		<p class="ctas">
			<?php if ( function_exists( 'wc_get_page_permalink' ) ) : ?>
				<a class="btn-primary" href="<?php echo esc_url( wc_get_page_permalink( 'shop' ) ); ?>"><?php esc_html_e( 'Shop all styles', 'mansu-rose' ); ?></a>
			<?php endif; ?>
			<a class="btn-ghost" href="<?php echo esc_url( mansu_wa_link() ); ?>" target="_blank" rel="noopener"><?php esc_html_e( 'Ask on WhatsApp', 'mansu-rose' ); ?></a>
		</p>
	</div>
</main>
<?php
get_footer();

<?php
/**
 * Home page: opening with the Style Finder, category circles, new in, best sellers, promises, FAQ.
 *
 * @package Mansu_Rose
 */

defined( 'ABSPATH' ) || exit;

get_header();
$wc   = class_exists( 'WooCommerce' );
$shop = $wc ? wc_get_page_permalink( 'shop' ) : home_url( '/' );

/**
 * Print a list of products with the shop card.
 *
 * @param array  $args  mansu_products() arguments.
 * @param string $class List class.
 */
$mansu_list = function ( $args, $class ) {
	$products = mansu_products( $args );
	if ( ! $products ) {
		return false;
	}
	echo '<ul class="products ' . esc_attr( $class ) . '">';
	foreach ( $products as $p ) {
		$GLOBALS['product'] = $p;
		$GLOBALS['post']    = get_post( $p->get_id() ); // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited
		setup_postdata( $GLOBALS['post'] );
		wc_get_template_part( 'content', 'product' );
	}
	wp_reset_postdata();
	echo '</ul>';
	return true;
};

/* Two portrait photos beside the heading: chosen in the Customizer, else the newest photographed products. */
$pics = array();
for ( $i = 1; $i <= 2; $i++ ) {
	$id = absint( mansu_opt( "hero_img{$i}" ) );
	if ( $id ) {
		$pics[] = $id;
	}
}
if ( count( $pics ) < 2 && $wc ) {
	foreach ( mansu_products( array( 'limit' => 2, 'photo' => true ) ) as $p ) {
		if ( count( $pics ) < 2 && ! in_array( $p->get_image_id(), $pics, true ) ) {
			$pics[] = (int) $p->get_image_id();
		}
	}
}
?>
<main id="main">
	<section class="hero" aria-labelledby="h1">
		<div class="wrap hero-in<?php echo $wc ? '' : ' no-finder'; ?>">
			<div class="hero-txt">
				<p class="kick"><?php echo esc_html( mansu_opt( 'hero_eyebrow' ) ); ?></p>
				<h1 id="h1"><?php echo esc_html( mansu_opt( 'hero_title' ) ); ?> <em><?php echo esc_html( mansu_opt( 'hero_em' ) ); ?></em></h1>
				<p class="lede"><?php echo esc_html( mansu_opt( 'hero_lede' ) ); ?></p>
				<?php if ( $pics ) : ?>
					<div class="pics" aria-hidden="true">
						<?php foreach ( $pics as $i => $id ) : ?>
							<?php echo wp_get_attachment_image( $id, 'woocommerce_thumbnail', false, $i ? array( 'alt' => '', 'loading' => 'lazy' ) : array( 'alt' => '', 'loading' => 'eager', 'fetchpriority' => 'high' ) ); ?>
						<?php endforeach; ?>
					</div>
				<?php endif; ?>
			</div>
			<?php if ( $wc ) { mansu_finder_form(); } ?>
		</div>
	</section>

	<?php if ( $wc && mansu_featured_cats() ) : ?>
	<nav class="wrap circles" aria-label="<?php esc_attr_e( 'Categories', 'mansu-rose' ); ?>">
		<a href="<?php echo esc_url( add_query_arg( 'orderby', 'date', $shop ) ); ?>">
			<?php
			$newest = mansu_products( array( 'limit' => 1, 'photo' => true ) );
			echo $newest ? wp_get_attachment_image( $newest[0]->get_image_id(), 'woocommerce_thumbnail', false, array( 'alt' => '', 'loading' => 'lazy' ) ) : '<span class="ph" aria-hidden="true"></span>';
			?>
			<span><?php esc_html_e( 'New in', 'mansu-rose' ); ?><small><?php esc_html_e( 'This week', 'mansu-rose' ); ?></small></span>
		</a>
		<?php foreach ( mansu_featured_cats() as $t ) : ?>
			<a href="<?php echo esc_url( get_term_link( $t ) ); ?>">
				<?php
				$img = mansu_term_image_id( $t );
				echo $img ? wp_get_attachment_image( $img, 'woocommerce_thumbnail', false, array( 'alt' => '', 'loading' => 'lazy' ) ) : '<span class="ph" aria-hidden="true"></span>';
				?>
				<span><?php echo esc_html( $t->name ); ?><small><?php echo esc_html( sprintf( /* translators: %d: count */ _n( '%d style', '%d styles', $t->count, 'mansu-rose' ), $t->count ) ); ?></small></span>
			</a>
		<?php endforeach; ?>
	</nav>
	<?php endif; ?>

	<?php if ( $wc ) : ?>
	<section class="sec" aria-labelledby="new-h">
		<div class="wrap">
			<div class="sec-head">
				<div><p class="kick"><?php esc_html_e( 'Just in', 'mansu-rose' ); ?></p><h2 id="new-h"><?php esc_html_e( 'New this week', 'mansu-rose' ); ?></h2></div>
				<a class="link-u" href="<?php echo esc_url( add_query_arg( 'orderby', 'date', $shop ) ); ?>"><?php esc_html_e( 'View all new in', 'mansu-rose' ); ?></a>
			</div>
			<?php $mansu_list( array( 'orderby' => 'date', 'limit' => 8 ), 'grid' ); ?>
		</div>
	</section>

	<section class="sec" aria-labelledby="best-h" style="padding-top:0">
		<div class="wrap">
			<div class="sec-head">
				<div><p class="kick"><?php esc_html_e( 'Loved in Accra', 'mansu-rose' ); ?></p><h2 id="best-h"><?php esc_html_e( 'Best sellers', 'mansu-rose' ); ?></h2></div>
				<a class="link-u" href="<?php echo esc_url( add_query_arg( 'orderby', 'popularity', $shop ) ); ?>"><?php esc_html_e( 'Shop the full collection', 'mansu-rose' ); ?></a>
			</div>
			<?php $mansu_list( array( 'orderby' => 'popularity', 'limit' => 8 ), 'grid' ); ?>
		</div>
	</section>
	<?php endif; ?>

	<section class="sec" aria-label="<?php esc_attr_e( 'Why shop with us', 'mansu-rose' ); ?>" style="padding-top:0">
		<div class="wrap promise">
			<?php
			$icons = array(
				1 => '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
				2 => '<path d="M4 21V9l8-5 8 5v12"/><path d="M9 21v-6h6v6"/>',
				3 => '<path d="M3 9h18l-2 11H5z"/><path d="M8 9V6a4 4 0 0 1 8 0v3"/>',
			);
			for ( $i = 1; $i <= 3; $i++ ) :
				if ( ! mansu_opt( "svc{$i}_title" ) ) {
					continue;
				}
				?>
				<div>
					<svg class="picon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><?php echo $icons[ $i ]; // phpcs:ignore WordPress.Security.EscapeOutput -- fixed markup. ?></svg>
					<h3><?php echo esc_html( mansu_opt( "svc{$i}_title" ) ); ?></h3>
					<p><?php echo esc_html( mansu_opt( "svc{$i}_text" ) ); ?></p>
				</div>
			<?php endfor; ?>
		</div>
	</section>

	<?php $faq = mansu_faq_items(); ?>
	<?php if ( $faq ) : ?>
	<section class="sec" aria-labelledby="faq-h" style="padding-top:0">
		<div class="wrap faq">
			<div><p class="kick"><?php esc_html_e( 'Help', 'mansu-rose' ); ?></p><h2 id="faq-h"><?php esc_html_e( 'Questions, answered', 'mansu-rose' ); ?></h2></div>
			<div>
				<?php foreach ( $faq as $qa ) : ?>
					<details><summary><?php echo esc_html( $qa[0] ); ?></summary><p><?php echo esc_html( $qa[1] ); ?></p></details>
				<?php endforeach; ?>
			</div>
		</div>
	</section>
	<?php endif; ?>
</main>
<?php
get_footer();

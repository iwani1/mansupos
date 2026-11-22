<?php
/**
 * Home page: opening, categories, new this week, occasions, best sellers, service, FAQ.
 *
 * @package Mansu_Maison
 */

defined( 'ABSPATH' ) || exit;

get_header();
$wc   = class_exists( 'WooCommerce' );
$shop = $wc ? wc_get_page_permalink( 'shop' ) : home_url( '/' );

/**
 * Print a list of products with the shop card.
 *
 * @param array  $args  wc_get_products() arguments.
 * @param string $class List class.
 */
$mansu_rail = function ( $args, $class ) {
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

$hero = array();
for ( $i = 1; $i <= 3; $i++ ) {
	$id = absint( mansu_opt( "hero_img{$i}" ) );
	if ( $id ) {
		$hero[] = array( 'id' => $id, 'label' => mansu_opt( "hero_label{$i}" ), 'link' => mansu_opt( "hero_link{$i}" ) ? mansu_opt( "hero_link{$i}" ) : $shop );
	}
}
/* No photos chosen yet: use the three newest photographed products so the page never opens empty. */
if ( ! $hero && $wc ) {
	foreach ( mansu_products( array( 'limit' => 3, 'photo' => true ) ) as $p ) {
		$hero[] = array( 'id' => $p->get_image_id(), 'label' => $p->get_name(), 'link' => $p->get_permalink() );
	}
}
?>
<main id="main">
	<section class="hero" aria-labelledby="h1">
		<div class="wrap hero-in<?php echo $hero ? '' : ' no-img'; ?>">
			<div class="hero-txt">
				<p class="eyebrow"><?php echo esc_html( mansu_opt( 'hero_eyebrow' ) ); ?></p>
				<h1 id="h1"><?php echo esc_html( mansu_opt( 'hero_title' ) ); ?> <em><?php echo esc_html( mansu_opt( 'hero_em' ) ); ?></em></h1>
				<p class="lede"><?php echo esc_html( mansu_opt( 'hero_lede' ) ); ?></p>
				<p class="ctas">
					<a class="btn-primary" href="<?php echo esc_url( add_query_arg( 'orderby', 'date', $shop ) ); ?>"><?php esc_html_e( 'Shop new in', 'mansu-maison' ); ?></a>
					<?php $first = mansu_featured_cats(); ?>
					<?php if ( $first ) : ?>
						<a class="btn-ghost" href="<?php echo esc_url( get_term_link( $first[0] ) ); ?>"><?php echo esc_html( sprintf( /* translators: %s: category */ __( 'Shop %s', 'mansu-maison' ), strtolower( $first[0]->name ) ) ); ?></a>
					<?php endif; ?>
				</p>
			</div>
			<?php if ( $hero ) : ?>
			<div class="collage n<?php echo count( $hero ); ?>">
				<?php foreach ( $hero as $i => $h ) : ?>
					<a href="<?php echo esc_url( $h['link'] ); ?>">
						<?php echo wp_get_attachment_image( $h['id'], 'woocommerce_single', false, $i ? array( 'loading' => 'lazy' ) : array( 'loading' => 'eager', 'fetchpriority' => 'high' ) ); ?>
						<?php if ( $h['label'] ) : ?><span><?php echo esc_html( $h['label'] ); ?></span><?php endif; ?>
					</a>
				<?php endforeach; ?>
			</div>
			<?php endif; ?>
		</div>
	</section>

	<?php if ( $wc && mansu_featured_cats() ) : ?>
	<section class="sec" aria-labelledby="cats-h" style="padding-top:0">
		<div class="wrap">
			<div class="sec-head"><div><div class="rule" aria-hidden="true"></div><h2 id="cats-h"><?php esc_html_e( 'Shop by category', 'mansu-maison' ); ?></h2></div></div>
			<div class="cats">
				<?php foreach ( mansu_featured_cats() as $t ) : ?>
					<a class="cat" href="<?php echo esc_url( get_term_link( $t ) ); ?>">
						<?php
						$img = mansu_term_image_id( $t );
						echo $img ? wp_get_attachment_image( $img, 'woocommerce_thumbnail', false, array( 'alt' => '', 'loading' => 'lazy' ) ) : '<span class="ph" aria-hidden="true"></span>';
						?>
						<span class="lab"><b><?php echo esc_html( $t->name ); ?></b><small><?php echo esc_html( sprintf( /* translators: %d: count */ _n( '%d style', '%d styles', $t->count, 'mansu-maison' ), $t->count ) ); ?></small></span>
					</a>
				<?php endforeach; ?>
			</div>
		</div>
	</section>
	<?php endif; ?>

	<?php if ( $wc ) : ?>
	<section class="sec wash" aria-labelledby="new-h">
		<div class="wrap">
			<div class="sec-head">
				<div><div class="rule" aria-hidden="true"></div><h2 id="new-h"><?php esc_html_e( 'New this week', 'mansu-maison' ); ?></h2><p><?php esc_html_e( 'Just photographed in the showroom. Limited pieces per size.', 'mansu-maison' ); ?></p></div>
				<a class="link-u" href="<?php echo esc_url( add_query_arg( 'orderby', 'date', $shop ) ); ?>"><?php esc_html_e( 'View all new in', 'mansu-maison' ); ?></a>
			</div>
			<?php $mansu_rail( array( 'orderby' => 'date' ), 'rail' ); ?>
		</div>
	</section>
	<?php endif; ?>

	<?php if ( mansu_occasions() ) : ?>
	<section class="sec" aria-labelledby="occ-h">
		<div class="wrap">
			<div class="sec-head"><div><div class="rule" aria-hidden="true"></div><h2 id="occ-h"><?php esc_html_e( 'Dress for the occasion', 'mansu-maison' ); ?></h2></div></div>
			<div class="occ n<?php echo count( mansu_occasions() ); ?>">
				<?php foreach ( mansu_occasions() as $o ) : ?>
					<a href="<?php echo esc_url( get_term_link( $o['term'] ) ); ?>">
						<?php echo $o['image'] ? wp_get_attachment_image( $o['image'], 'woocommerce_single', false, array( 'alt' => '', 'loading' => 'lazy' ) ) : '<span class="ph" aria-hidden="true"></span>'; ?>
						<div><b><?php echo esc_html( $o['label'] ); ?></b><small><?php echo esc_html( sprintf( /* translators: %d: count */ _n( '%d style', '%d styles', $o['term']->count, 'mansu-maison' ), $o['term']->count ) ); ?></small></div>
					</a>
				<?php endforeach; ?>
			</div>
		</div>
	</section>
	<?php endif; ?>

	<?php if ( $wc ) : ?>
	<section class="sec" aria-labelledby="best-h" style="padding-top:1rem">
		<div class="wrap">
			<div class="sec-head">
				<div><div class="rule" aria-hidden="true"></div><h2 id="best-h"><?php esc_html_e( 'Best sellers', 'mansu-maison' ); ?></h2></div>
				<a class="link-u" href="<?php echo esc_url( add_query_arg( 'orderby', 'popularity', $shop ) ); ?>"><?php esc_html_e( 'Shop the full collection', 'mansu-maison' ); ?></a>
			</div>
			<?php $mansu_rail( array( 'orderby' => 'popularity' ), 'grid' ); ?>
		</div>
	</section>
	<?php endif; ?>

	<section class="sec" aria-label="<?php esc_attr_e( 'Our service', 'mansu-maison' ); ?>">
		<div class="wrap services">
			<?php for ( $i = 1; $i <= 3; $i++ ) : ?>
				<?php if ( mansu_opt( "svc{$i}_title" ) ) : ?>
					<div><h3><?php echo esc_html( mansu_opt( "svc{$i}_title" ) ); ?></h3><p><?php echo esc_html( mansu_opt( "svc{$i}_text" ) ); ?></p></div>
				<?php endif; ?>
			<?php endfor; ?>
		</div>
	</section>

	<?php $faq = mansu_faq_items(); ?>
	<?php if ( $faq ) : ?>
	<section class="sec" aria-labelledby="faq-h">
		<div class="wrap faq">
			<div><div class="rule" aria-hidden="true"></div><h2 id="faq-h"><?php esc_html_e( 'Questions, answered', 'mansu-maison' ); ?></h2></div>
			<div>
				<?php foreach ( $faq as $i => $qa ) : ?>
					<details<?php echo 0 === $i ? ' open' : ''; ?>><summary><?php echo esc_html( $qa[0] ); ?></summary><p><?php echo esc_html( $qa[1] ); ?></p></details>
				<?php endforeach; ?>
			</div>
		</div>
	</section>
	<?php endif; ?>
</main>
<?php
get_footer();
